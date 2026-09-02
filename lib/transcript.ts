import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { ApiError } from "@/lib/http";

const timestamp = z.string().min(10).max(50).refine((value) => Number.isFinite(Date.parse(value)), "时间格式无效");

export const transcriptInputSchema = z.object({
  messages: z.array(z.object({
    sequenceNo: z.number().int().positive().max(10_000),
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

export type TranscriptMessage = z.infer<typeof transcriptInputSchema>["messages"][number];

interface RequestRow {
  id: string;
  client_request_id: string;
  turn_index: number;
  status: "in_progress" | "completed" | "failed" | "uncertain";
  requested_at: Date;
  reply_started_at: Date | null;
  completed_at: Date | null;
  coze_chat_id: string | null;
  metadata: Record<string, unknown>;
}

export async function persistTranscript(
  client: PoolClient,
  sessionId: string,
  messages: TranscriptMessage[],
  options: { requireComplete: boolean; storageMode: "background_checkpoint" | "automatic_completion" | "participant_switch" },
) {
  const requests = await client.query<RequestRow>(
    `SELECT id, client_request_id, turn_index, status, requested_at, reply_started_at, completed_at, coze_chat_id, metadata
     FROM chat_requests WHERE session_id = $1 ORDER BY turn_index ASC`,
    [sessionId],
  );
  const turns = new Map<number, TranscriptMessage[]>();
  for (const message of messages) {
    const group = turns.get(message.turnIndex) ?? [];
    group.push(message);
    turns.set(message.turnIndex, group);
  }
  for (const [turnIndex, turnMessages] of [...turns.entries()].sort((a, b) => a[0] - b[0])) {
    const user = turnMessages.find((message) => message.role === "user");
    if (!user?.clientRequestId) {
      if (options.requireComplete) throw new ApiError(400, "INCOMPLETE_TRANSCRIPT", `第 ${turnIndex} 轮缺少参与者消息。`);
      continue;
    }
    const assistants = turnMessages.filter((message) => message.role === "assistant");
    const requestedAt = new Date(user.sentAt);
    const replyStartedAt = assistants.map((message) => message.replyStartedAt).filter((value): value is string => Boolean(value)).sort()[0] ?? null;
    const completedAt = assistants.map((message) => message.replyCompletedAt ?? message.sentAt).sort().at(-1) ?? null;
    const cozeChatId = assistants.find((message) => message.cozeChatId)?.cozeChatId ?? user.cozeChatId;
    const inserted = await client.query<RequestRow>(
      `INSERT INTO chat_requests (
         id, session_id, client_request_id, turn_index, status, user_message_id,
         coze_chat_id, requested_at, started_at, completed_at, reply_started_at, metadata
       ) VALUES ($1,$2,$3,$4,$5,NULL,$6,$7,$7,$8,$9,$10::jsonb)
       ON CONFLICT (session_id, client_request_id) DO UPDATE SET
         status = EXCLUDED.status,
         coze_chat_id = COALESCE(chat_requests.coze_chat_id, EXCLUDED.coze_chat_id),
         completed_at = COALESCE(chat_requests.completed_at, EXCLUDED.completed_at),
         reply_started_at = COALESCE(chat_requests.reply_started_at, EXCLUDED.reply_started_at),
         metadata = chat_requests.metadata || EXCLUDED.metadata
       RETURNING id, client_request_id, turn_index, status, requested_at,
         reply_started_at, completed_at, coze_chat_id, metadata`,
      [randomUUID(), sessionId, user.clientRequestId, turnIndex,
        assistants.length > 0 ? "completed" : "uncertain", cozeChatId,
        requestedAt, completedAt ? new Date(completedAt) : null,
        replyStartedAt ? new Date(replyStartedAt) : null,
        JSON.stringify({
          user_content: user.content,
          user_sequence: user.sequenceNo,
          assistant_start_sequence: assistants[0]?.sequenceNo ?? user.sequenceNo + 1,
          imported_at_completion: true,
          assistant_transcript: assistants.map((message) => ({
            id: message.cozeMessageId ? `coze-${message.cozeMessageId}` : `imported-${turnIndex}-${message.sequenceNo}`,
            sequenceNo: message.sequenceNo,
            turnIndex,
            content: message.content,
            sentAt: message.sentAt,
            replyStartedAt: message.replyStartedAt,
            replyCompletedAt: message.replyCompletedAt,
            latencyMs: message.latencyMs,
            cozeMessageId: message.cozeMessageId,
            cozeChatId: message.cozeChatId,
          })),
        })],
    );
    const existingIndex = requests.rows.findIndex((row) => row.turn_index === turnIndex);
    if (existingIndex >= 0) requests.rows[existingIndex] = inserted.rows[0];
    else requests.rows.push(inserted.rows[0]);
  }
  const byTurn = new Map(requests.rows.map((row) => [row.turn_index, row]));
  const includedUsers = new Set<string>();
  const includedAssistants = new Set<string>();
  const seenSequences = new Set<number>();

  for (const message of messages) {
    if (seenSequences.has(message.sequenceNo)) throw new ApiError(400, "INVALID_TRANSCRIPT", "交互记录中存在重复的消息顺序。");
    seenSequences.add(message.sequenceNo);
    const request = byTurn.get(message.turnIndex);
    if (!request) throw new ApiError(400, "INVALID_TRANSCRIPT", "交互记录与当前实验 Session 不匹配。");
    let authoritativeContent = message.content;
    let authoritativeAssistant: Record<string, unknown> | null = null;
    if (message.role === "user") {
      if (!message.clientRequestId || message.clientRequestId !== request.client_request_id) {
        throw new ApiError(400, "INVALID_TRANSCRIPT", "参与者消息的请求标识不一致。");
      }
      if (typeof request.metadata.user_content === "string" && request.metadata.user_content.trim()) {
        authoritativeContent = request.metadata.user_content;
      }
      includedUsers.add(request.id);
    } else {
      const transcript = Array.isArray(request.metadata.assistant_transcript)
        ? request.metadata.assistant_transcript.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object")
        : [];
      authoritativeAssistant = transcript.find((item) =>
        (message.cozeMessageId && item.cozeMessageId === message.cozeMessageId)
        || item.sequenceNo === message.sequenceNo,
      ) ?? null;
      if (authoritativeAssistant && typeof authoritativeAssistant.content === "string") {
        authoritativeContent = authoritativeAssistant.content;
      } else if (request.status === "completed" && transcript.length > 0) {
        throw new ApiError(400, "INVALID_TRANSCRIPT", "AI 消息与服务端保存的回复不一致。");
      }
      includedAssistants.add(request.id);
    }
    if (message.cozeChatId && request.coze_chat_id && message.cozeChatId !== request.coze_chat_id) {
      throw new ApiError(400, "INVALID_TRANSCRIPT", "交互记录中的 Coze Chat 标识不一致。");
    }

    const messageId = randomUUID();
    const assistantSentAt = authoritativeAssistant && typeof authoritativeAssistant.sentAt === "string"
      ? new Date(authoritativeAssistant.sentAt)
      : new Date(message.sentAt);
    const sentAt = message.role === "user" ? request.requested_at : assistantSentAt;
    const replyStartedAt = message.role === "assistant"
      ? request.reply_started_at ?? (message.replyStartedAt ? new Date(message.replyStartedAt) : null)
      : null;
    const replyCompletedAt = message.role === "assistant"
      ? request.completed_at ?? (message.replyCompletedAt ? new Date(message.replyCompletedAt) : null)
      : null;
    const latencyMs = message.role === "assistant" && replyCompletedAt
      ? Math.max(0, replyCompletedAt.getTime() - request.requested_at.getTime())
      : null;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO messages (id, session_id, chat_request_id, sequence_no, turn_index, role, content,
         client_request_id, coze_message_id, coze_chat_id, sent_at, reply_started_at, reply_completed_at,
         latency_ms, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [messageId, sessionId, request.id, message.sequenceNo, request.turn_index, message.role, authoritativeContent,
        message.role === "user" ? message.clientRequestId : null, message.cozeMessageId, request.coze_chat_id,
        sentAt, replyStartedAt, replyCompletedAt, latencyMs,
        JSON.stringify({ storage_mode: options.storageMode, browser_sent_at: message.sentAt })],
    );
    if (message.role === "user") {
      let userMessageId = inserted.rows[0]?.id;
      if (!userMessageId) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM messages WHERE session_id = $1 AND client_request_id = $2 LIMIT 1`,
          [sessionId, message.clientRequestId],
        );
        userMessageId = existing.rows[0]?.id;
      }
      if (userMessageId) await client.query(`UPDATE chat_requests SET user_message_id = $2 WHERE id = $1`, [request.id, userMessageId]);
    }
  }

  if (options.requireComplete) {
    const missingUser = requests.rows.find((row) => !includedUsers.has(row.id));
    if (missingUser) throw new ApiError(400, "INCOMPLETE_TRANSCRIPT", `第 ${missingUser.turn_index} 轮缺少参与者消息。`);
    const missingAssistant = requests.rows.find((row) => row.status === "completed" && !includedAssistants.has(row.id));
    if (missingAssistant) throw new ApiError(400, "INCOMPLETE_TRANSCRIPT", `第 ${missingAssistant.turn_index} 轮缺少 AI 回复。`);
  }
  if (messages.length > 0) {
    const maxSequence = Math.max(...messages.map((message) => message.sequenceNo));
    const firstUser = [...messages].sort((a, b) => a.sequenceNo - b.sequenceNo).find((message) => message.role === "user");
    const title = firstUser ? Array.from(firstUser.content.replace(/\s+/g, " ").trim()).slice(0, 28).join("") || "新对话" : "新对话";
    await client.query(
      `UPDATE experiment_sessions
       SET next_sequence = GREATEST(next_sequence, $2), last_activity_at = now(),
         metadata = CASE WHEN COALESCE(metadata->>'conversation_title', '新对话') = '新对话'
           THEN jsonb_set(metadata, '{conversation_title}', to_jsonb($3::text), true)
           ELSE metadata END
       WHERE id = $1`,
      [sessionId, maxSequence + 1, title],
    );
  }
}
