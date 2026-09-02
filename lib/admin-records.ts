import "server-only";

import { randomUUID } from "node:crypto";
import { transaction } from "@/db";

export async function deleteParticipantRecord(input: {
  experimentId: string;
  participantId: string;
  confirmationCode: string;
}, adminUserId: string) {
  return transaction(async (client) => {
    const participant = await client.query<{ id: string; external_code: string; created_at: string }>(
      `SELECT id, external_code, created_at
       FROM participants
       WHERE id = $1 AND experiment_id = $2
       FOR UPDATE`,
      [input.participantId, input.experimentId],
    );
    const row = participant.rows[0];
    if (!row) throw new Error("PARTICIPANT_NOT_FOUND");
    if (input.confirmationCode !== row.external_code) throw new Error("PARTICIPANT_CONFIRMATION_MISMATCH");

    const counts = await client.query<{ session_count: string; request_count: string; message_count: string }>(
      `SELECT
         count(DISTINCT session.id)::text AS session_count,
         count(DISTINCT request.id)::text AS request_count,
         count(DISTINCT message.id)::text AS message_count
       FROM experiment_sessions session
       LEFT JOIN chat_requests request ON request.session_id = session.id
       LEFT JOIN messages message ON message.session_id = session.id
       WHERE session.participant_id = $1 AND session.experiment_id = $2`,
      [row.id, input.experimentId],
    );
    const deletionSummary = {
      participantId: row.id,
      participantCode: row.external_code,
      participantCreatedAt: row.created_at,
      sessionCount: Number(counts.rows[0]?.session_count ?? 0),
      requestCount: Number(counts.rows[0]?.request_count ?? 0),
      messageCount: Number(counts.rows[0]?.message_count ?? 0),
    };

    await client.query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, before_data)
       VALUES ($1,$2,'participant.record.delete',$3,$4::jsonb)`,
      [randomUUID(), adminUserId, input.experimentId, JSON.stringify(deletionSummary)],
    );
    await client.query(
      `DELETE FROM messages
       WHERE session_id IN (
         SELECT id FROM experiment_sessions WHERE participant_id = $1 AND experiment_id = $2
       )`,
      [row.id, input.experimentId],
    );
    await client.query(
      `DELETE FROM chat_requests
       WHERE session_id IN (
         SELECT id FROM experiment_sessions WHERE participant_id = $1 AND experiment_id = $2
       )`,
      [row.id, input.experimentId],
    );
    await client.query(
      `DELETE FROM participant_agent_assignments assignment
       USING experiment_runs run
       WHERE assignment.experiment_run_id = run.id
         AND assignment.participant_id = $1 AND run.experiment_id = $2`,
      [row.id, input.experimentId],
    );
    await client.query(
      `DELETE FROM experiment_sessions WHERE participant_id = $1 AND experiment_id = $2`,
      [row.id, input.experimentId],
    );
    await client.query(
      `DELETE FROM participants WHERE id = $1 AND experiment_id = $2`,
      [row.id, input.experimentId],
    );
    return deletionSummary;
  });
}
