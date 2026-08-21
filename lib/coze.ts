import "server-only";

import { randomUUID } from "node:crypto";
import { ChatStatus, CozeAPI, RoleType, type ChatV3Message, type CreateChatData } from "@coze/api";
import { query, transaction } from "@/db";
import type { StoredMessage } from "@/db/schema";
import type { AuthenticatedSession } from "@/lib/session";
import { getRuntimeAiConfig } from "@/lib/experiment-settings";

const TERMINAL = new Set([ChatStatus.COMPLETED, ChatStatus.FAILED, ChatStatus.CANCELED, ChatStatus.REQUIRES_ACTION]);

async function getCozeClient(session: AuthenticatedSession) {
  const config = await getRuntimeAiConfig(session.experimentId, session.configSnapshot);
  if (!config.token) throw new Error("Coze API Token is not configured");
  if (!config.botId) throw new Error("Coze Bot ID is not configured");
  return { client: new CozeAPI({
    token: config.token,
    baseURL: config.baseUrl,
    axiosOptions: { timeout: 15_000 },
  }), botId: config.botId };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface RequestRecord {
  id: string;
  status: "in_progress" | "completed" | "failed" | "uncertain";
  cozeChatId: string | null;
  cozeConversationId: string | null;
  requestedAt: string;
  metadata: Record<string, unknown>;
}

export async function beginChatRequest(session: AuthenticatedSession, clientRequestId: string, content: string, databaseMessagesEnabled: boolean) {
  return transaction(async (client) => {
    const existing = await client.query<{ id: string; status: RequestRecord["status"]; coze_chat_id: string | null; coze_conversation_id: string | null; requested_at: string; metadata: Record<string, unknown> }>(
      `SELECT id, status, coze_chat_id, coze_conversation_id, requested_at, metadata
       FROM chat_requests WHERE session_id = $1 AND client_request_id = $2`,
      [session.id, clientRequestId],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      return { created: false as const, request: { id: row.id, status: row.status, cozeChatId: row.coze_chat_id, cozeConversationId: row.coze_conversation_id, requestedAt: row.requested_at, metadata: row.metadata } };
    }

    const requestId = randomUUID();
    const conversationTitle = Array.from(content.replace(/\s+/g, " ").trim()).slice(0, 28).join("") || "新对话";
    const locked = await client.query<{ sequence_no: number }>(
      `UPDATE experiment_sessions
       SET active_request_id = $2, next_sequence = next_sequence + 1, last_activity_at = now(),
           metadata = CASE WHEN COALESCE(metadata->>'conversation_title', '新对话') = '新对话'
             THEN jsonb_set(metadata, '{conversation_title}', to_jsonb($3::text), true) ELSE metadata END
       WHERE id = $1 AND status = 'active' AND active_request_id IS NULL
       RETURNING next_sequence - 1 AS sequence_no`,
      [session.id, requestId, conversationTitle],
    );
    if (!locked.rows[0]) throw Object.assign(new Error("Another request is active"), { code: "SESSION_BUSY" });

    const metadata = { database_messages_enabled: databaseMessagesEnabled, storage_mode: "deferred_until_completion", user_sequence: locked.rows[0].sequence_no, content_length: Array.from(content).length };
    await client.query(
      `INSERT INTO chat_requests (id, session_id, client_request_id, status, user_message_id, metadata)
       VALUES ($1, $2, $3, 'in_progress', $4, $5::jsonb)`,
      [requestId, session.id, clientRequestId, null, JSON.stringify(metadata)],
    );
    return { created: true as const, request: { id: requestId, status: "in_progress" as const, cozeChatId: null, cozeConversationId: null, requestedAt: new Date().toISOString(), metadata } };
  });
}

export async function createCozeChat(session: AuthenticatedSession, requestId: string, clientRequestId: string, content: string) {
  const coze = await getCozeClient(session);
  const chat = await coze.client.chat.create({
    bot_id: coze.botId,
    user_id: session.cozeUserId,
    conversation_id: session.cozeConversationId ?? undefined,
    auto_save_history: true,
    additional_messages: [{ role: RoleType.User, type: "question", content, content_type: "text" }],
    meta_data: { edulab_session: session.publicId, edulab_request: clientRequestId },
  });
  await transaction(async (client) => {
    await client.query(`UPDATE chat_requests SET coze_chat_id = $2, coze_conversation_id = $3 WHERE id = $1`, [requestId, chat.id, chat.conversation_id]);
    await client.query(`UPDATE experiment_sessions SET coze_conversation_id = $2 WHERE id = $1 AND coze_conversation_id IS NULL`, [session.id, chat.conversation_id]);
  });
  return chat;
}

export async function waitForCozeChat(session: AuthenticatedSession, chat: CreateChatData, timeoutMs = 45_000) {
  const coze = (await getCozeClient(session)).client;
  const deadline = Date.now() + timeoutMs;
  let current = chat;
  while (!TERMINAL.has(current.status) && Date.now() < deadline) {
    await delay(400);
    current = await coze.chat.retrieve(chat.conversation_id, chat.id);
  }
  if (!TERMINAL.has(current.status)) return { pending: true as const, chat: current, messages: [] as ChatV3Message[] };
  const messages = await coze.chat.messages.list(chat.conversation_id, chat.id);
  return { pending: false as const, chat: current, messages };
}

function assistantAnswers(messages: ChatV3Message[]) {
  return messages.filter((message) => message.role === RoleType.Assistant && message.type === "answer" && message.content.trim());
}

export async function finalizeCompletedRequest(sessionId: string, requestId: string, chat: CreateChatData, messages: ChatV3Message[]): Promise<StoredMessage[]> {
  const answers = assistantAnswers(messages);
  if (chat.status !== ChatStatus.COMPLETED || answers.length === 0) {
    const errorCode = chat.last_error?.code ? String(chat.last_error.code) : chat.status;
    const errorMessage = chat.last_error?.msg ?? (chat.status === ChatStatus.REQUIRES_ACTION ? "The Coze agent requested an unsupported tool action" : "Coze did not return an answer");
    await markRequestFailed(sessionId, requestId, errorCode, errorMessage);
    throw Object.assign(new Error(errorMessage), { code: "COZE_FAILED" });
  }

  return transaction(async (client) => {
    const request = await client.query<{ status: string; requested_at: Date }>(`SELECT status, requested_at FROM chat_requests WHERE id = $1 FOR UPDATE`, [requestId]);
    if (!request.rows[0] || request.rows[0].status === "completed") return [];
    const allocation = await client.query<{ start_sequence: number }>(
      `UPDATE experiment_sessions SET next_sequence = next_sequence + $2, last_activity_at = now(), active_request_id = NULL
       WHERE id = $1 RETURNING next_sequence - $2 AS start_sequence`,
      [sessionId, answers.length],
    );
    const start = allocation.rows[0].start_sequence;
    const completedAt = chat.completed_at ? new Date(chat.completed_at * 1000) : new Date();
    const replyStartedAt = new Date(Math.min(...answers.map((message) => message.created_at * 1000)));
    const latencyMs = Math.max(0, completedAt.getTime() - request.rows[0].requested_at.getTime());

    const completedMessages: StoredMessage[] = [];
    for (const [index, answer] of answers.entries()) {
      const message = {
        id: randomUUID(), sessionId, requestId, sequenceNo: start + index,
        content: answer.content, cozeMessageId: answer.id, cozeChatId: chat.id,
        sentAt: new Date(answer.created_at * 1000), replyStartedAt, completedAt, latencyMs,
        metadata: { content_type: answer.content_type, message_type: answer.type, section_id: answer.section_id, updated_at: answer.updated_at },
      };
      completedMessages.push({
        id: `coze-${answer.id}`,
        sequenceNo: message.sequenceNo, role: "assistant", content: message.content,
        sentAt: message.sentAt.toISOString(), replyStartedAt: replyStartedAt.toISOString(),
        replyCompletedAt: completedAt.toISOString(), latencyMs, clientRequestId: null, status: "completed",
      });
    }
    await client.query(
      `UPDATE chat_requests SET status = 'completed', completed_at = $2, reply_started_at = $3,
         coze_chat_id = $4, coze_conversation_id = $5, metadata = metadata || $6::jsonb
       WHERE id = $1`,
      [requestId, completedAt, replyStartedAt, chat.id, chat.conversation_id, JSON.stringify({ coze_status: chat.status, answer_count: answers.length, assistant_start_sequence: start })],
    );
    return completedMessages;
  });
}

async function loadUnstoredRequestMessages(session: AuthenticatedSession, request: Pick<RequestRecord, "cozeChatId" | "cozeConversationId" | "requestedAt" | "metadata">): Promise<StoredMessage[]> {
  if (!request.cozeChatId || !request.cozeConversationId) return [];
  const coze = (await getCozeClient(session)).client;
  const messages = await coze.chat.messages.list(request.cozeConversationId, request.cozeChatId);
  const answers = assistantAnswers(messages);
  const start = Number(request.metadata.assistant_start_sequence ?? Number.MAX_SAFE_INTEGER - answers.length);
  const replyStartedAt = answers.length ? new Date(Math.min(...answers.map((message) => message.created_at * 1000))) : null;
  return answers.map((answer, index) => {
    const sentAt = new Date(answer.created_at * 1000);
    return {
      id: `coze-${answer.id}`, sequenceNo: start + index, role: "assistant" as const, content: answer.content,
      sentAt: sentAt.toISOString(), replyStartedAt: replyStartedAt?.toISOString() ?? null,
      replyCompletedAt: sentAt.toISOString(), latencyMs: Math.max(0, sentAt.getTime() - new Date(request.requestedAt).getTime()),
      clientRequestId: null, status: "completed" as const,
    };
  });
}

export async function getUnstoredCompletedRequestMessages(session: AuthenticatedSession, request: RequestRecord) {
  return loadUnstoredRequestMessages(session, request);
}

export async function markRequestFailed(sessionId: string, requestId: string, code: string, message: string, status: "failed" | "uncertain" = "failed") {
  await transaction(async (client) => {
    await client.query(
      `UPDATE chat_requests SET status = $2, completed_at = now(), error_code = $3, error_message = $4 WHERE id = $1 AND status = 'in_progress'`,
      [requestId, status, code.slice(0, 120), message.slice(0, 1000)],
    );
    await client.query(`UPDATE experiment_sessions SET active_request_id = NULL, last_activity_at = now() WHERE id = $1 AND active_request_id = $2`, [sessionId, requestId]);
  });
}

export async function recoverPendingRequest(session: AuthenticatedSession): Promise<{ pending: boolean; messages: StoredMessage[] }> {
  const pending = await query<{ id: string; coze_chat_id: string | null; coze_conversation_id: string | null; started_at: Date; requested_at: string; metadata: Record<string, unknown> }>(
    `SELECT id, coze_chat_id, coze_conversation_id, started_at, requested_at, metadata FROM chat_requests
     WHERE session_id = $1 AND status = 'in_progress' ORDER BY started_at ASC LIMIT 1`,
    [session.id],
  );
  const request = pending.rows[0];
  if (!request) {
    const latest = await query<{ coze_chat_id: string | null; coze_conversation_id: string | null; requested_at: string; metadata: Record<string, unknown> }>(
      `SELECT coze_chat_id, coze_conversation_id, requested_at, metadata FROM chat_requests
       WHERE session_id = $1 AND status = 'completed' ORDER BY completed_at DESC LIMIT 1`, [session.id],
    );
    const row = latest.rows[0];
    if (!row) return { pending: false, messages: [] };
    return { pending: false, messages: await loadUnstoredRequestMessages(session, { cozeChatId: row.coze_chat_id, cozeConversationId: row.coze_conversation_id, requestedAt: row.requested_at, metadata: row.metadata }) };
  }
  if (!request.coze_chat_id || !request.coze_conversation_id) {
    if (Date.now() - request.started_at.getTime() > 120_000) await markRequestFailed(session.id, request.id, "UNKNOWN_AFTER_CREATE", "Request outcome could not be verified", "uncertain");
    return { pending: true, messages: [] };
  }
  const coze = (await getCozeClient(session)).client;
  let chat;
  try { chat = await coze.chat.retrieve(request.coze_conversation_id, request.coze_chat_id); }
  catch (error) {
    if (Date.now() - request.started_at.getTime() > 15 * 60_000) {
      await markRequestFailed(session.id, request.id, "RECOVERY_TIMEOUT", error instanceof Error ? error.message : "Recovery timed out", "uncertain");
      return { pending: false, messages: [] };
    }
    return { pending: true, messages: [] };
  }
  if (!TERMINAL.has(chat.status)) {
    if (Date.now() - request.started_at.getTime() > 15 * 60_000) {
      await markRequestFailed(session.id, request.id, "COZE_TIMEOUT", "Coze chat remained in progress for over 15 minutes", "uncertain");
      return { pending: false, messages: [] };
    }
    return { pending: true, messages: [] };
  }
  const messages = await coze.chat.messages.list(request.coze_conversation_id, request.coze_chat_id);
  const completed = await finalizeCompletedRequest(session.id, request.id, chat, messages);
  return { pending: false, messages: completed };
}
