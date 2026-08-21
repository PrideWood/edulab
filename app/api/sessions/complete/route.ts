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
    turnIndex: z.number().int().positive().max(2000),
    sentAt: timestamp,
    replyStartedAt: timestamp.nullable(),
    replyCompletedAt: timestamp.nullable(),
    latencyMs: z.number().int().nonnegative().max(24 * 60 * 60 * 1000).nullable(),
    clientRequestId: z.uuid().nullable(),
    cozeMessageId: z.string().min(1).max(200).nullable(),
    cozeChatId: z.string().min(1).max(200).nullable(),
  })).max(2000),
});

interface RequestRow {
  id: string;
  client_request_id: string;
  turn_index: number;
  status: "in_progress" | "completed" | "failed" | "uncertain";
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
        if (Number(existing.rows[0]?.count ?? 0) === 0) {
          const requests = await client.query<RequestRow>(
            `SELECT id, client_request_id, turn_index, status, requested_at, reply_started_at, completed_at, coze_chat_id
             FROM chat_requests WHERE session_id = $1 ORDER BY turn_index ASC`,
            [session.id],
          );
          const byClientId = new Map(requests.rows.map((row) => [row.client_request_id, row]));
          const includedUserRequests = new Set<string>();
          const assistantCounts = new Map<string, number>();
          let currentRequest: RequestRow | null = null;
          for (const [index, message] of input.data.messages.entries()) {
            if (message.role === "user") {
              if (!message.clientRequestId) throw new ApiError(400, "INVALID_TRANSCRIPT", "参与者消息缺少请求标识，无法安全保存。");
              currentRequest = byClientId.get(message.clientRequestId) ?? null;
              if (!currentRequest) throw new ApiError(400, "INVALID_TRANSCRIPT", "本地记录与当前实验 Session 不匹配。");
              if (message.turnIndex !== currentRequest.turn_index) throw new ApiError(400, "INVALID_TRANSCRIPT", "交互记录的轮次信息不一致。");
              includedUserRequests.add(currentRequest.id);
            } else if (!currentRequest) {
              throw new ApiError(400, "INVALID_TRANSCRIPT", "AI 消息缺少对应的参与者请求。");
            } else {
              if (message.turnIndex !== currentRequest.turn_index) throw new ApiError(400, "INVALID_TRANSCRIPT", "AI 消息的轮次信息不一致。");
              assistantCounts.set(currentRequest.id, (assistantCounts.get(currentRequest.id) ?? 0) + 1);
            }
            if (message.cozeChatId && message.cozeChatId !== currentRequest.coze_chat_id) throw new ApiError(400, "INVALID_TRANSCRIPT", "交互记录中的 Coze Chat 标识不一致。");

            const messageId = randomUUID();
            const sentAt = message.role === "user" ? currentRequest.requested_at : new Date(message.sentAt);
            const replyStartedAt = message.role === "assistant" ? currentRequest.reply_started_at ?? (message.replyStartedAt ? new Date(message.replyStartedAt) : null) : null;
            const replyCompletedAt = message.role === "assistant" ? currentRequest.completed_at ?? (message.replyCompletedAt ? new Date(message.replyCompletedAt) : null) : null;
            const latencyMs = message.role === "assistant" && replyCompletedAt
              ? Math.max(0, replyCompletedAt.getTime() - currentRequest.requested_at.getTime())
              : null;
            await client.query(
              `INSERT INTO messages (id, session_id, chat_request_id, sequence_no, turn_index, role, content,
                 client_request_id, coze_message_id, coze_chat_id, sent_at, reply_started_at, reply_completed_at,
                 latency_ms, metadata)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
              [messageId, session.id, currentRequest.id, index + 1, currentRequest.turn_index, message.role, message.content,
                message.role === "user" ? message.clientRequestId : null, message.cozeMessageId, currentRequest.coze_chat_id,
                sentAt, replyStartedAt, replyCompletedAt, latencyMs,
                JSON.stringify({ storage_mode: "deferred_until_completion", browser_sent_at: message.sentAt })],
            );
            if (message.role === "user") {
              await client.query(`UPDATE chat_requests SET user_message_id = $2 WHERE id = $1`, [currentRequest.id, messageId]);
            }
          }
          const missingUser = requests.rows.find((row) => !includedUserRequests.has(row.id));
          if (missingUser) throw new ApiError(400, "INCOMPLETE_TRANSCRIPT", `第 ${missingUser.turn_index} 轮缺少参与者消息，请刷新页面恢复完整记录后重试。`);
          const missingAssistant = requests.rows.find((row) => row.status === "completed" && !assistantCounts.has(row.id));
          if (missingAssistant) throw new ApiError(400, "INCOMPLETE_TRANSCRIPT", `第 ${missingAssistant.turn_index} 轮缺少 AI 回复，请刷新页面恢复完整记录后重试。`);
        }
      }

      const result = await client.query<{ completed_at: string }>(
        `UPDATE experiment_sessions SET status = 'completed', completed_at = COALESCE(completed_at, now()), last_activity_at = now(),
           metadata = metadata || $2::jsonb
         WHERE id = $1 AND active_request_id IS NULL RETURNING completed_at`,
        [session.id, JSON.stringify({
          transcript_storage: state.controls.databaseMessagesEnabled ? "database_at_completion" : "browser_export_only",
          transcript_message_count: input.data.messages.length,
          transcript_turn_count: new Set(input.data.messages.map((message) => message.turnIndex)).size,
        })],
      );
      if (!result.rows[0]) throw new ApiError(409, "SESSION_BUSY", "请等待 AI 完成本次回复后再结束实验。");
      return result.rows[0].completed_at;
    });

    const completedState = await getSessionControls({ ...session, status: "completed" });
    return NextResponse.json({
      session: { id: session.publicId, status: "completed", startedAt: session.startedAt, lastActivityAt: completedAt, participantCode: session.participantCode, cozeConversationId: session.cozeConversationId },
      messages: await listMessages(session.id), pending: false, failedRequest: null, controls: completedState.controls,
    });
  } catch (error) { return errorResponse(error); }
}
