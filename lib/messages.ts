import "server-only";

import { query } from "@/db";
import type { StoredMessage } from "@/db/schema";

export async function listMessages(sessionId: string): Promise<StoredMessage[]> {
  const result = await query<{
    id: string; sequence_no: number; role: "user" | "assistant"; content: string;
    sent_at: string; reply_started_at: string | null; reply_completed_at: string | null;
    latency_ms: number | null; client_request_id: string | null; status: "completed";
  }>(`SELECT id, sequence_no, role, content, sent_at, reply_started_at,
             reply_completed_at, latency_ms, client_request_id, status
      FROM messages WHERE session_id = $1 ORDER BY sequence_no ASC`, [sessionId]);
  return result.rows.map((row) => ({
    id: row.id, sequenceNo: row.sequence_no, role: row.role, content: row.content,
    sentAt: row.sent_at, replyStartedAt: row.reply_started_at,
    replyCompletedAt: row.reply_completed_at, latencyMs: row.latency_ms,
    clientRequestId: row.client_request_id, status: row.status,
  }));
}

export async function getLatestFailedRequest(sessionId: string) {
  const result = await query<{ content: string; error_message: string | null }>(
    `SELECT m.content, r.error_message
     FROM chat_requests r JOIN messages m ON m.id = r.user_message_id
     WHERE r.session_id = $1 AND r.status IN ('failed', 'uncertain')
       AND NOT EXISTS (
         SELECT 1 FROM chat_requests newer
         WHERE newer.session_id = r.session_id AND newer.requested_at > r.requested_at
       )
     ORDER BY r.requested_at DESC LIMIT 1`,
    [sessionId],
  );
  const row = result.rows[0];
  return row ? { content: row.content, message: "上一条消息未能获得 AI 回复，你可以重新发送。" } : null;
}
