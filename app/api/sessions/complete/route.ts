import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { transaction } from "@/db";
import { ApiError, errorResponse } from "@/lib/http";
import { listMessages } from "@/lib/messages";
import { getAuthenticatedSession } from "@/lib/session";
import { getSessionControls } from "@/lib/experiment-limits";

const timestamp = z.string().min(10).max(50).refine((value) => Number.isFinite(Date.parse(value)), "时间格式无效");
const inputSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant"]),
    content: z.string().min(1).max(100_000),
    sentAt: timestamp,
    replyStartedAt: timestamp.nullable(),
    replyCompletedAt: timestamp.nullable(),
    latencyMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).nullable(),
    clientRequestId: z.uuid().nullable(),
  })).max(2000),
});

interface RequestRow {
  id: string;
  client_request_id: string;
  requested_at: Date;
  reply_started_at: Date | null;
  completed_at: Date | null;
  coze_chat_id: string | null;
}

export async function POST(request: Request) {
  try {
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    if (session.activeRequestId) throw new ApiError(409, "SESSION_BUSY", "请等待 AI 完成本次回复后再结束实验。");
    const input = inputSchema.safeParse(await request.json().catch(() => ({ messages: [] })));
    if (!input.success) throw new ApiError(400, "INVALID_TRANSCRIPT", input.error.issues[0]?.message ?? "本地对话记录格式无效。");
    const state = await getSessionControls(session);

    const completedAt = await transaction(async (client) => {
      if (state.controls.databaseMessagesEnabled) {
        const existing = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM messages WHERE session_id = $1`, [session.id]);
        if (Number(existing.rows[0]?.count ?? 0) === 0 && input.data.messages.length > 0) {
          const requests = await client.query<RequestRow>(
            `SELECT id, client_request_id, requested_at, reply_started_at, completed_at, coze_chat_id
             FROM chat_requests WHERE session_id = $1 ORDER BY requested_at ASC`,
            [session.id],
          );
          const byClientId = new Map(requests.rows.map((row) => [row.client_request_id, row]));
          let currentRequest: RequestRow | null = null;
          for (const [index, message] of input.data.messages.entries()) {
            if (message.role === "user") {
              if (!message.clientRequestId) throw new ApiError(400, "INVALID_TRANSCRIPT", "参与者消息缺少请求标识，无法安全保存。");
              currentRequest = byClientId.get(message.clientRequestId) ?? null;
              if (!currentRequest) throw new ApiError(400, "INVALID_TRANSCRIPT", "本地记录与当前实验 Session 不匹配。");
            } else if (!currentRequest) {
              throw new ApiError(400, "INVALID_TRANSCRIPT", "AI 消息缺少对应的参与者请求。");
            }

            const messageId = randomUUID();
            const sentAt = message.role === "user" ? currentRequest.requested_at : new Date(message.sentAt);
            const replyStartedAt = message.role === "assistant" ? currentRequest.reply_started_at ?? (message.replyStartedAt ? new Date(message.replyStartedAt) : null) : null;
            const replyCompletedAt = message.role === "assistant" ? currentRequest.completed_at ?? (message.replyCompletedAt ? new Date(message.replyCompletedAt) : null) : null;
            const latencyMs = message.role === "assistant" && replyCompletedAt
              ? Math.max(0, replyCompletedAt.getTime() - currentRequest.requested_at.getTime())
              : null;
            await client.query(
              `INSERT INTO messages (id, session_id, chat_request_id, sequence_no, role, content,
                 client_request_id, coze_chat_id, sent_at, reply_started_at, reply_completed_at,
                 latency_ms, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)`,
              [messageId, session.id, currentRequest.id, index + 1, message.role, message.content,
                message.role === "user" ? message.clientRequestId : null, currentRequest.coze_chat_id,
                sentAt, replyStartedAt, replyCompletedAt, latencyMs,
                JSON.stringify({ storage_mode: "deferred_until_completion", browser_sent_at: message.sentAt })],
            );
            if (message.role === "user") {
              await client.query(`UPDATE chat_requests SET user_message_id = $2 WHERE id = $1`, [currentRequest.id, messageId]);
            }
          }
        }
      }

      const result = await client.query<{ completed_at: string }>(
        `UPDATE experiment_sessions SET status = 'completed', completed_at = COALESCE(completed_at, now()), last_activity_at = now(),
           metadata = metadata || $2::jsonb
         WHERE id = $1 AND active_request_id IS NULL RETURNING completed_at`,
        [session.id, JSON.stringify({ transcript_storage: state.controls.databaseMessagesEnabled ? "database_at_completion" : "browser_export_only" })],
      );
      if (!result.rows[0]) throw new ApiError(409, "SESSION_BUSY", "请等待 AI 完成本次回复后再结束实验。");
      return result.rows[0].completed_at;
    });

    const completedState = await getSessionControls({ ...session, status: "completed" });
    return NextResponse.json({
      session: { id: session.publicId, status: "completed", startedAt: session.startedAt, lastActivityAt: completedAt, participantCode: session.participantCode },
      messages: await listMessages(session.id), pending: false, failedRequest: null, controls: completedState.controls,
    });
  } catch (error) { return errorResponse(error); }
}
