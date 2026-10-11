import "server-only";

import { after } from "next/server";
import { query, transaction } from "@/db";
import type { StoredMessage } from "@/db/schema";
import { markRequestFailed, type RequestRecord } from "@/lib/coze";
import { getRuntimeAiConfig } from "@/lib/experiment-settings";
import type { AuthenticatedSession } from "@/lib/session";
import type { SessionPayload } from "@/lib/client-types";
import { persistTranscript } from "@/lib/transcript";
import { DifyChatError, difyUser, findDifyMessage, runDifyChat, safeDifyError, type DifyReply } from "@/lib/dify";
import { originalStudentMessage } from "@/lib/session-memory";

interface DifyRequestRow {
  id: string; client_request_id: string; turn_index: number; status: RequestRecord["status"];
  requested_at: string | Date; metadata: Record<string, unknown>;
}

function requestRecord(row: DifyRequestRow): RequestRecord {
  return { id: row.id, clientRequestId: row.client_request_id, turnIndex: row.turn_index,
    status: row.status, requestedAt: new Date(row.requested_at).toISOString(),
    cozeChatId: null, cozeConversationId: null, metadata: row.metadata };
}

function completedReply(request: RequestRecord): DifyReply | null {
  const raw = request.metadata.dify_completed_reply as DifyReply | undefined;
  return raw?.completedAt && raw.messageId && raw.conversationId && typeof raw.answer === "string" ? raw : null;
}

function replyMessages(request: RequestRecord, reply: DifyReply, userContent: string, assistantSequence?: number): StoredMessage[] {
  const sequence = Number(request.metadata.user_sequence);
  const common = { turnIndex: request.turnIndex, cozeMessageId: null, cozeChatId: null,
    provider: "dify" as const, providerTaskId: reply.taskId, status: "completed" as const };
  const messages: StoredMessage[] = [];
  if (userContent) messages.push({ ...common, id: `request-user-${request.clientRequestId}`,
    sequenceNo: sequence, role: "user", content: userContent, sentAt: request.requestedAt,
    replyStartedAt: null, replyCompletedAt: null, latencyMs: null,
    clientRequestId: request.clientRequestId, providerMessageId: null });
  messages.push({ ...common, id: `dify-${reply.messageId}`,
    sequenceNo: assistantSequence ?? Number(request.metadata.assistant_start_sequence ?? sequence + 1),
    role: "assistant", content: reply.answer, sentAt: reply.replyStartedAt ?? reply.completedAt!,
    replyStartedAt: reply.replyStartedAt, replyCompletedAt: reply.completedAt,
    latencyMs: Math.max(0, Date.parse(reply.completedAt!) - Date.parse(request.requestedAt)),
    clientRequestId: null, providerMessageId: reply.messageId });
  return messages;
}

async function checkpoint(session: AuthenticatedSession, request: RequestRecord, reply: DifyReply) {
  const metadata = {
    provider: "dify", dify_conversation_id: reply.conversationId,
    dify_message_id: reply.messageId, dify_task_id: reply.taskId,
    dify_last_event_at: new Date().toISOString(),
    ...(reply.completedAt ? { dify_stream_completed: true } : {}),
    ...(reply.completedAt && request.metadata.database_messages_enabled === true ? { dify_completed_reply: reply } : {}),
  };
  await transaction(async client => {
    const current = await client.query<{ dify_conversation_id: string | null }>(
      "SELECT dify_conversation_id FROM experiment_sessions WHERE id=$1 FOR UPDATE", [session.id]);
    if (!current.rows[0] || (current.rows[0].dify_conversation_id && current.rows[0].dify_conversation_id !== reply.conversationId)) {
      throw new DifyChatError("CONVERSATION_MISMATCH", "实验会话与 Dify 上下文不一致，已停止处理。");
    }
    await client.query(`UPDATE chat_requests SET metadata=metadata || $3::jsonb
      WHERE id=$1 AND session_id=$2 AND status='in_progress'`, [request.id, session.id, JSON.stringify(metadata)]);
    if (reply.conversationId) await client.query(`UPDATE experiment_sessions SET dify_conversation_id=COALESCE(dify_conversation_id,$2)
      WHERE id=$1`, [session.id, reply.conversationId]);
  });
  Object.assign(request.metadata, metadata);
  session.difyConversationId = reply.conversationId;
}

export async function finalizeDifyRequest(session: AuthenticatedSession, request: RequestRecord, reply: DifyReply, userContent: string) {
  if (!reply.completedAt || !reply.messageId || !reply.conversationId || !reply.answer.trim()) throw new DifyChatError("INCOMPLETE_REPLY", "Dify 回复尚未完成。");
  return transaction(async client => {
    await client.query("SELECT id FROM experiment_sessions WHERE id=$1 FOR UPDATE", [session.id]);
    const locked = await client.query<DifyRequestRow>(`SELECT id, client_request_id, turn_index, status, requested_at, metadata
      FROM chat_requests WHERE id=$1 AND session_id=$2 FOR UPDATE`, [request.id, session.id]);
    const row = locked.rows[0];
    if (!row || row.status !== "in_progress") return [];
    const allocation = await client.query<{ sequence: number }>(`UPDATE experiment_sessions
      SET next_sequence=next_sequence+1, last_activity_at=now(), active_request_id=NULL
      WHERE id=$1 AND active_request_id=$2 RETURNING next_sequence-1 AS sequence`, [session.id, request.id]);
    if (!allocation.rows[0]) throw new DifyChatError("REQUEST_MISMATCH", "当前实验请求标识不一致。");
    const actual = requestRecord(row);
    const metadata = { ...row.metadata, provider: "dify", dify_stream_completed: true,
      dify_conversation_id: reply.conversationId, dify_message_id: reply.messageId, dify_task_id: reply.taskId,
      assistant_start_sequence: allocation.rows[0].sequence,
      ...(row.metadata.database_messages_enabled === true ? { dify_completed_reply: reply } : {}),
    };
    actual.metadata = metadata;
    const messages = replyMessages(actual, reply, typeof row.metadata.user_content === "string" ? row.metadata.user_content : userContent);
    if (row.metadata.database_messages_enabled === true) Object.assign(metadata, {
      assistant_transcript: messages.filter(message => message.role === "assistant"),
    });
    await client.query(`UPDATE chat_requests SET status='completed', completed_at=$3, reply_started_at=$4,
      metadata=$5::jsonb WHERE id=$1 AND session_id=$2`,
    [request.id, session.id, reply.completedAt, reply.replyStartedAt, JSON.stringify(metadata)]);
    await client.query(`UPDATE experiment_sessions SET dify_conversation_id=COALESCE(dify_conversation_id,$2) WHERE id=$1`, [session.id, reply.conversationId]);
    if (row.metadata.database_messages_enabled === true) {
      await persistTranscript(client, session.id, messages, { requireComplete: false, storageMode: "background_checkpoint" });
    }
    request.metadata = metadata;
    session.difyConversationId = reply.conversationId;
    return messages;
  });
}

async function historyReply(session: AuthenticatedSession, request: RequestRecord) {
  const cached = completedReply(request);
  if (cached) return { reply: cached, query: String(request.metadata.user_content ?? "") };
  const conversationId = request.metadata.dify_conversation_id;
  const messageId = request.metadata.dify_message_id;
  if (typeof conversationId !== "string" || typeof messageId !== "string") return null;
  if (session.difyConversationId && session.difyConversationId !== conversationId) throw new DifyChatError("CONVERSATION_MISMATCH", "Dify 恢复会话标识不一致。");
  const config = await getRuntimeAiConfig(session.experimentId, session.configSnapshot);
  const message = await findDifyMessage({ ...config, user: difyUser(session), conversationId, messageId });
  if (!message) return null;
  if (message.error || message.status === "error" || message.status === "failed") throw new DifyChatError("DIFY_MESSAGE_FAILED", "Dify 会话中的这次请求未成功完成。", 502, true);
  if (message.status !== "normal" || !message.answer?.trim()) return null;
  const completedAt = new Date().toISOString();
  const memory = request.metadata.history_memory as {injected?:boolean} | undefined;
  return { query: originalStudentMessage(message.query,memory?.injected === true), reply: { conversationId, messageId,
    taskId: typeof request.metadata.dify_task_id === "string" ? request.metadata.dify_task_id : null,
    answer: message.answer, replyStartedAt: new Date(message.created_at * 1000).toISOString(), completedAt } };
}

export async function getDifyCompletedRequestMessages(session: AuthenticatedSession, request: RequestRecord) {
  const result = await historyReply(session, request);
  return result ? replyMessages(request, result.reply, result.query) : [];
}

export async function recoverDifyPendingRequest(session: AuthenticatedSession): Promise<{ pending: boolean; messages: StoredMessage[] }> {
  const rows = await query<DifyRequestRow>(`SELECT id, client_request_id, turn_index, status, requested_at, metadata
    FROM chat_requests WHERE session_id=$1 ORDER BY turn_index`, [session.id]);
  const messages: StoredMessage[] = [];
  let pending = false;
  for (const row of rows.rows) {
    const request = requestRecord(row);
    if (request.status === "completed") {
      // Stored messages remain available even if an upstream history lookup fails.
      try { messages.push(...await getDifyCompletedRequestMessages(session, request)); } catch { /* Retry on the next refresh. */ }
      continue;
    }
    if (request.status !== "in_progress") continue;
    const age = Date.now() - Date.parse(request.requestedAt);
    const heartbeat = Date.parse(String(request.metadata.dify_last_event_at ?? request.requestedAt));
    // Never finalize a still-live stream using a potentially partial history row.
    if (!completedReply(request) && request.metadata.dify_stream_completed !== true
      && request.metadata.dify_stream_closed !== true && Date.now() - heartbeat < 65_000) { pending = true; continue; }
    try {
      const result = await historyReply(session, request);
      if (result) {
        messages.push(...await finalizeDifyRequest(session, request, result.reply, result.query));
        continue;
      }
    } catch (error) {
      if (error instanceof DifyChatError && error.definitive) {
        await markRequestFailed(session.id, request.id, error.code, safeDifyError(error));
        continue;
      }
    }
    const hasMessageId = typeof request.metadata.dify_message_id === "string";
    if (age > (hasMessageId ? 15 * 60_000 : 120_000)) {
      await markRequestFailed(session.id, request.id, "DIFY_UNCERTAIN", "Dify 请求结果无法确认，请联系教师核验，暂勿重复发送。", "uncertain");
    } else pending = true;
  }
  return { pending, messages: messages.sort((a, b) => a.sequenceNo - b.sequenceNo) };
}

export function createDifyChatResponse(session: AuthenticatedSession, request: RequestRecord, content: string,
  payload: (messages: StoredMessage[]) => Promise<SessionPayload>, providerContent = content) {
  const encoder = new TextEncoder();
  let disconnected = false;
  let completion: Promise<void> = Promise.resolve();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      function emit(value: object) {
        if (disconnected) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); }
        catch { disconnected = true; }
      }
      completion = (async () => {
        let secret = "";
        let providerFinished = false;
        try {
          const config = await getRuntimeAiConfig(session.experimentId, session.configSnapshot);
          secret = config.token;
          emit({ event: "start", sessionId: session.publicId, clientRequestId: request.clientRequestId });
          let lastIds = "", lastCheckpoint = 0;
          const result = await runDifyChat({ ...config, user: difyUser(session), conversationId: session.difyConversationId ?? null,
            content:providerContent, signal: AbortSignal.timeout(50_000), onProgress: async reply => {
              const ids = JSON.stringify([reply.conversationId, reply.messageId, reply.taskId]);
              if (ids !== lastIds || reply.completedAt || Date.now() - lastCheckpoint >= 1000) {
                await checkpoint(session, request, reply);
                lastIds = ids; lastCheckpoint = Date.now();
              }
              if (reply.answer) emit({ event: "delta", sessionId: session.publicId, clientRequestId: request.clientRequestId, answer: reply.answer });
            } });
          providerFinished = true;
          const messages = await finalizeDifyRequest(session, request, result, content);
          emit({ event: "completed", payload: await payload(messages) });
        } catch (error) {
          const safe = error instanceof DifyChatError ? safeDifyError(error, secret)
            : "AI 回复暂时中断，正在恢复已保存的结果。请暂勿重复发送。";
          // Once Dify finished, leave the completed checkpoint recoverable if a
          // database finalization or payload read fails. Do not resend the query.
          try {
            if (!providerFinished && error instanceof DifyChatError && error.definitive) {
              await markRequestFailed(session.id, request.id, error.code, safe);
            } else {
              await query(`UPDATE chat_requests SET metadata=metadata || '{"dify_stream_closed":true}'::jsonb
                WHERE id=$1 AND session_id=$2 AND status='in_progress'`, [request.id, session.id]);
            }
          } catch { /* The durable request remains discoverable on refresh. */ }
          emit({ event: "error", code: error instanceof DifyChatError ? error.code : "DIFY_INTERRUPTED", message: safe });
        } finally {
          if (!disconnected) { try { controller.close(); } catch { /* Browser disconnected. */ } }
        }
      })();
    },
    cancel() { disconnected = true; },
  });
  // Keep the same bounded operation alive on serverless hosts when the student
  // refreshes or disconnects. IDs and final results still go to the database.
  after(() => completion);
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
