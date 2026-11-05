import "server-only";

import { after } from "next/server";
import { query, transaction } from "@/db";
import type { StoredMessage } from "@/db/schema";
import { markRequestFailed, type RequestRecord } from "@/lib/coze";
import { getRuntimeAiConfig } from "@/lib/experiment-settings";
import type { AuthenticatedSession } from "@/lib/session";
import type { SessionPayload } from "@/lib/client-types";
import { listMessages } from "@/lib/messages";
import { persistTranscript } from "@/lib/transcript";
import { DeepSeekError, runDeepSeekChat, type ModelMessage, type ModelReply } from "@/lib/deepseek";

export async function finalizeDeepSeekRequest(session: AuthenticatedSession, request: RequestRecord, reply: ModelReply) {
  return transaction(async client => {
    await client.query("SELECT id FROM experiment_sessions WHERE id=$1 FOR UPDATE", [session.id]);
    const locked = await client.query<{ status: string; metadata: Record<string, unknown> }>(
      "SELECT status, metadata FROM chat_requests WHERE id=$1 AND session_id=$2 FOR UPDATE", [request.id, session.id]);
    if (locked.rows[0]?.status === "completed") return [];
    if (locked.rows[0]?.status !== "in_progress") throw new Error("REQUEST_NOT_ACTIVE");
    const allocation = await client.query<{ sequence: number }>(`UPDATE experiment_sessions
      SET next_sequence=next_sequence+1, last_activity_at=now(), active_request_id=NULL
      WHERE id=$1 AND active_request_id=$2 RETURNING next_sequence-1 AS sequence`, [session.id, request.id]);
    if (!allocation.rows[0]) throw new Error("REQUEST_MISMATCH");
    const metadata = locked.rows[0].metadata;
    const messages: StoredMessage[] = [{
      id: `request-user-${request.clientRequestId}`, sequenceNo: Number(metadata.user_sequence), turnIndex: request.turnIndex,
      role: "user", content: String(metadata.user_content ?? ""), sentAt: request.requestedAt,
      replyStartedAt: null, replyCompletedAt: null, latencyMs: null, clientRequestId: request.clientRequestId,
      cozeMessageId: null, cozeChatId: null, provider: "deepseek", status: "completed",
    }, {
      id: `deepseek-${request.id}`, sequenceNo: allocation.rows[0].sequence, turnIndex: request.turnIndex,
      role: "assistant", content: reply.answer, sentAt: reply.replyStartedAt ?? reply.completedAt,
      replyStartedAt: reply.replyStartedAt, replyCompletedAt: reply.completedAt,
      latencyMs: Math.max(0, Date.parse(reply.completedAt) - Date.parse(request.requestedAt)), clientRequestId: null,
      cozeMessageId: null, cozeChatId: null, provider: "deepseek", providerMessageId: reply.messageId || null, status: "completed",
    }];
    await client.query(`UPDATE chat_requests SET status='completed', completed_at=$3, reply_started_at=$4,
      metadata=metadata || $5::jsonb WHERE id=$1 AND session_id=$2`, [request.id, session.id, reply.completedAt, reply.replyStartedAt,
      JSON.stringify({ assistant_transcript: messages.filter(message => message.role === "assistant"), deepseek_completed_reply: reply })]);
    await persistTranscript(client, session.id, messages, { requireComplete: false, storageMode: "background_checkpoint" });
    return messages;
  });
}

export async function getDeepSeekCompletedRequestMessages(session: AuthenticatedSession, request: RequestRecord) {
  return (await listMessages(session.id)).filter(message => message.turnIndex === request.turnIndex);
}

export async function recoverDeepSeekPendingRequest(session: AuthenticatedSession) {
  const pending = await query<{ id: string; client_request_id: string; turn_index: number; requested_at: string; metadata: Record<string, unknown> }>(
    "SELECT id, client_request_id, turn_index, requested_at, metadata FROM chat_requests WHERE session_id=$1 AND status='in_progress' ORDER BY turn_index", [session.id]);
  let live = false;
  for (const row of pending.rows) {
    const request: RequestRecord = { id: row.id, clientRequestId: row.client_request_id, turnIndex: row.turn_index,
      requestedAt: new Date(row.requested_at).toISOString(), metadata: row.metadata, status: "in_progress", cozeChatId: null, cozeConversationId: null };
    const reply = row.metadata.deepseek_completed_reply as ModelReply | undefined;
    if (reply?.completedAt && reply.answer) {
      await finalizeDeepSeekRequest(session, request, reply);
    } else if (Date.now() - Date.parse(request.requestedAt) > 125_000 || row.metadata.deepseek_stream_closed === true) {
      await markRequestFailed(session.id, row.id, "DEEPSEEK_UNCERTAIN", "DeepSeek 请求结果无法确认，请联系教师核验，暂勿重复发送。", "uncertain");
    } else live = true;
  }
  return { pending: live, messages: await listMessages(session.id) };
}

export function createDeepSeekChatResponse(session: AuthenticatedSession, request: RequestRecord, providerContent: string,
  payload: (messages: StoredMessage[]) => Promise<SessionPayload>) {
  const encoder = new TextEncoder();
  let disconnected = false, completion: Promise<void> = Promise.resolve();
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    const emit = (data: object) => {
      if (!disconnected) { try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { disconnected = true; } }
    };
    const heartbeat = setInterval(() => {
      if (!disconnected) { try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { disconnected = true; } }
    }, 10_000);
    completion = (async () => {
      let checkpointed = false;
      try {
        const config = await getRuntimeAiConfig(session.experimentId, session.configSnapshot);
        // Re-send only completed turns from this session, never failed student messages.
        const history = await query<{ role: "user" | "assistant"; content: string }>(`SELECT m.role, m.content
          FROM messages m JOIN chat_requests r ON r.id=m.chat_request_id
          WHERE m.session_id=$1 AND r.status='completed' AND r.turn_index<$2 ORDER BY m.sequence_no`, [session.id, request.turnIndex]);
        const messages: ModelMessage[] = [...history.rows, { role: "user", content: providerContent }];
        emit({ event: "start", sessionId: session.publicId, clientRequestId: request.clientRequestId });
        const reply = await runDeepSeekChat({ ...config, messages, signal: AbortSignal.timeout(110_000),
          onAnswer: async answer => { emit({ event: "delta", sessionId: session.publicId, clientRequestId: request.clientRequestId, answer }); } });
        // Durable completion precedes finalization; refresh never resends the model request.
        const checkpoint = await query(`UPDATE chat_requests SET metadata=metadata || $3::jsonb WHERE id=$1 AND session_id=$2 AND status='in_progress'`,
          [request.id, session.id, JSON.stringify({ deepseek_completed_reply: reply })]);
        if (checkpoint.rowCount !== 1) throw new Error("REQUEST_NOT_ACTIVE");
        checkpointed = true;
        emit({ event: "completed", payload: await payload(await finalizeDeepSeekRequest(session, request, reply)) });
      } catch (error) {
        const message = error instanceof DeepSeekError ? error.message : "模型回复暂时中断，正在核对已保存的结果，请暂勿重复发送。";
        try {
          if (!checkpointed) await markRequestFailed(session.id, request.id, error instanceof DeepSeekError ? error.code : "DEEPSEEK_INTERRUPTED",
            message, error instanceof DeepSeekError && error.definitive ? "failed" : "uncertain");
        } catch { /* Recovery resolves expired operations if the database is temporarily unavailable. */ }
        emit({ event: "error", message });
      } finally {
        clearInterval(heartbeat);
        if (!disconnected) { try { controller.close(); } catch { /* Browser disconnected. */ } }
      }
    })();
  }, cancel() { disconnected = true; } });
  after(() => completion);
  return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
}
