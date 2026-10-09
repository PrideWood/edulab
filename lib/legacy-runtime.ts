import "server-only";

import { randomUUID } from "node:crypto";
import { getRuntimeSession } from "@/lib/runtime-session";
import { sessionTransaction } from "@/lib/session-write";
import type { AuthenticatedSession } from "@/lib/session";

// Adopt provider IDs from old encrypted cookies before retiring the old fast
// path. Never trust a runtime cookie without database authentication.
export async function importLegacyRuntime(session: AuthenticatedSession) {
  const runtime = await getRuntimeSession();
  if (!runtime || runtime.session.publicId !== session.publicId || runtime.session.sessionSecretHash !== session.sessionSecretHash) return;
  await sessionTransaction(session, async (client) => {
    await client.query(`UPDATE experiment_sessions SET metadata=metadata || jsonb_build_object(
      'legacy_usage_floor', jsonb_build_object('count', $2::integer, 'through', clock_timestamp()))
      WHERE id=$1 AND NOT metadata ? 'legacy_usage_floor'`,
    [session.id, runtime.usedMessages + (runtime.pendingRequest ? 1 : 0)]);
    const request = runtime.pendingRequest ?? runtime.lastCompletedRequest;
    if (request) {
      const result = await client.query<{ id: string }>(
        `INSERT INTO chat_requests (id, session_id, client_request_id, turn_index, status,
           coze_chat_id, coze_conversation_id, requested_at, started_at, metadata)
         VALUES ($1,$2,$3,$4,'in_progress',$5,$6,$7,$7,$8::jsonb)
         ON CONFLICT DO NOTHING RETURNING id`,
        [randomUUID(), session.id, request.clientRequestId, request.turnIndex, request.chatId,
          request.conversationId, request.requestedAt, JSON.stringify({
            user_sequence: request.userSequence,
            database_messages_enabled: session.configSnapshot?.storage.databaseMessagesEnabled ?? true,
            storage_mode: "legacy_runtime_recovery",
          })],
      );
      if (result.rows[0]) {
        await client.query(`UPDATE experiment_sessions SET active_request_id=$2,
          next_sequence=GREATEST(next_sequence,$3) WHERE id=$1 AND active_request_id IS NULL`,
        [session.id, result.rows[0].id, request.userSequence + 1]);
        session.activeRequestId = result.rows[0].id;
      }
    }
    await client.query(`UPDATE experiment_sessions SET coze_conversation_id=COALESCE(coze_conversation_id,$2)
      WHERE id=$1`, [session.id, runtime.session.cozeConversationId]);
    session.cozeConversationId ??= runtime.session.cozeConversationId;
  });
}
