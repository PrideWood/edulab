import "server-only";

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { ApiError } from "@/lib/http";

const timestamp = z.string().min(10).max(50).refine((value) => Number.isFinite(Date.parse(value)), "时间格式无效");

export const transcriptInputSchema = z.object({
  sessionId: z.uuid().optional(),
  storedMessageCount: z.number().int().nonnegative().max(2000).optional(),
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

export async function verifyStoredTranscript(client: PoolClient, sessionId: string, expected: number) {
  await client.query(`SELECT id FROM experiment_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
  const result = await client.query<{ count: number; turns: number; invalid: boolean }>(
    `SELECT (SELECT count(*)::int FROM messages WHERE session_id=$1) AS count,
      (SELECT count(DISTINCT turn_index)::int FROM messages WHERE session_id=$1) AS turns,
      EXISTS (SELECT 1 FROM chat_requests r WHERE r.session_id=$1 AND (
        NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_request_id=r.id AND m.role='user') OR
        (r.status='completed' AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.chat_request_id=r.id AND m.role='assistant'))
      )) AS invalid`, [sessionId]);
  if (result.rows[0].count !== expected || result.rows[0].invalid) {
    throw new ApiError(409, "INCOMPLETE_TRANSCRIPT", "云端记录数量尚未核对一致，请重新提交交互记录。");
  }
  return result.rows[0];
}

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
  // Serialize uploads only for this conversation, never for other students.
  await client.query(`SELECT id FROM experiment_sessions WHERE id=$1 FOR UPDATE`, [sessionId]);
  const requests = await client.query<RequestRow>(
    `SELECT id, client_request_id, turn_index, status, requested_at, reply_started_at, completed_at, coze_chat_id, metadata
     FROM chat_requests WHERE session_id = $1 ORDER BY turn_index ASC`,
    [sessionId],
  );
  const turns = new Map<number, TranscriptMessage[]>();
  const newRequests: Record<string, unknown>[] = [];
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
    const existing = requests.rows.find(row => row.turn_index === turnIndex);
    if (existing && existing.client_request_id !== user.clientRequestId) {
      throw new ApiError(409, "INVALID_TRANSCRIPT", "同一轮次的请求标识不一致，请保留本地记录并联系实验人员。");
    }
    if (turnMessages.filter(message => message.role === "user").length !== 1) {
      throw new ApiError(400, "INVALID_TRANSCRIPT", "同一轮次必须且只能有一条参与者消息。");
    }
    newRequests.push({
      id: randomUUID(), session_id: sessionId, client_request_id: user.clientRequestId,
      turn_index: turnIndex, status: assistants.length > 0 ? "completed" : "uncertain",
      coze_chat_id: cozeChatId, requested_at: requestedAt, started_at: requestedAt,
      completed_at: completedAt, reply_started_at: replyStartedAt,
      metadata: {
        user_content: user.content, user_sequence: user.sequenceNo,
        assistant_start_sequence: assistants[0]?.sequenceNo ?? user.sequenceNo + 1,
        imported_at_completion: true,
        assistant_transcript: assistants.map(message => ({ ...message,
          id: message.cozeMessageId ? `coze-${message.cozeMessageId}` : `imported-${turnIndex}-${message.sequenceNo}`,
        })),
      },
    });
  }
  if (newRequests.length) {
    const inserted = await client.query<RequestRow>(
      `INSERT INTO chat_requests (
         id, session_id, client_request_id, turn_index, status, user_message_id,
         coze_chat_id, requested_at, started_at, completed_at, reply_started_at, metadata
       ) SELECT id, session_id, client_request_id, turn_index, status, NULL,
         coze_chat_id, requested_at, started_at, completed_at, reply_started_at, metadata
         FROM jsonb_populate_recordset(NULL::chat_requests, $1::jsonb)
       ON CONFLICT (session_id, client_request_id) DO UPDATE SET
         status = CASE WHEN chat_requests.status='completed' THEN chat_requests.status ELSE EXCLUDED.status END,
         coze_chat_id = COALESCE(chat_requests.coze_chat_id, EXCLUDED.coze_chat_id),
         completed_at = COALESCE(chat_requests.completed_at, EXCLUDED.completed_at),
         reply_started_at = COALESCE(chat_requests.reply_started_at, EXCLUDED.reply_started_at),
         metadata = CASE WHEN chat_requests.status='completed' THEN chat_requests.metadata
           ELSE EXCLUDED.metadata || (chat_requests.metadata - 'assistant_transcript') END
       RETURNING id, client_request_id, turn_index, status, requested_at,
         reply_started_at, completed_at, coze_chat_id, metadata`,
      [JSON.stringify(newRequests)],
    );
    for (const row of inserted.rows) {
      const existingIndex = requests.rows.findIndex(item => item.turn_index === row.turn_index);
      if (existingIndex >= 0) requests.rows[existingIndex] = row;
      else requests.rows.push(row);
    }
  }
  const byTurn = new Map(requests.rows.map((row) => [row.turn_index, row]));
  const includedUsers = new Set<string>();
  const includedAssistants = new Set<string>();
  const seenSequences = new Set<number>();
  const messageRows: Record<string, unknown>[] = [];

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
    messageRows.push({
      id: messageId, session_id: sessionId, chat_request_id: request.id,
      sequence_no: message.sequenceNo, turn_index: request.turn_index, role: message.role,
      content: authoritativeContent, client_request_id: message.role === "user" ? message.clientRequestId : null,
      coze_message_id: message.cozeMessageId, coze_chat_id: request.coze_chat_id,
      sent_at: sentAt, reply_started_at: replyStartedAt, reply_completed_at: replyCompletedAt,
      latency_ms: latencyMs, metadata: { storage_mode: options.storageMode, browser_sent_at: message.sentAt },
    });
  }
  if (messageRows.length) {
    await client.query(
      `INSERT INTO messages (id, session_id, chat_request_id, sequence_no, turn_index, role, content,
         client_request_id, coze_message_id, coze_chat_id, sent_at, reply_started_at, reply_completed_at,
         latency_ms, metadata)
       SELECT id, session_id, chat_request_id, sequence_no, turn_index, role, content,
         client_request_id, coze_message_id, coze_chat_id, sent_at, reply_started_at, reply_completed_at,
         latency_ms, metadata FROM jsonb_populate_recordset(NULL::messages, $1::jsonb)
       ON CONFLICT DO NOTHING`,
      [JSON.stringify(messageRows)],
    );
    const mismatch = await client.query<{ invalid: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM jsonb_populate_recordset(NULL::messages, $1::jsonb) incoming
       WHERE NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id=incoming.session_id
         AND m.sequence_no=incoming.sequence_no AND m.role=incoming.role
         AND m.chat_request_id=incoming.chat_request_id AND m.content=incoming.content)) AS invalid`,
      [JSON.stringify(messageRows)]);
    if (mismatch.rows[0].invalid) {
      throw new ApiError(409, "INVALID_TRANSCRIPT", "提交记录与已保存的消息顺序或内容冲突，请保留本地记录并联系实验人员。");
    }
    await client.query(`UPDATE chat_requests r SET user_message_id=m.id FROM messages m
      WHERE r.session_id=$1 AND m.chat_request_id=r.id AND m.role='user'
        AND r.user_message_id IS DISTINCT FROM m.id`, [sessionId]);
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
