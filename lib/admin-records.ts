import "server-only";

import { randomUUID } from "node:crypto";
import { query, transaction } from "@/db";
import { ApiError } from "@/lib/http";

export async function getParticipantInteractions(experimentId: string, participantId: string, publicSessionId?: string | null) {
  const participant = await query("SELECT id FROM participants WHERE id=$1 AND experiment_id=$2",[participantId,experimentId]);
  if (!participant.rows[0]) throw new ApiError(404,"PARTICIPANT_NOT_FOUND","找不到这条参与者记录。");
  const sessions = await query<{id:string;public_id:string;status:string;started_at:string;last_activity_at:string;
    completed_at:string|null;experiment_run_id:string|null;agent_id:string|null;metadata:Record<string,unknown>;
    draft_text:string;turn_count:string;message_count:string}>(`SELECT s.id,s.public_id,s.status,s.started_at,s.last_activity_at,s.completed_at,
      s.experiment_run_id,s.agent_id,s.metadata,s.draft_text,
      (SELECT count(*)::text FROM chat_requests WHERE session_id=s.id) AS turn_count,
      (SELECT count(*)::text FROM messages WHERE session_id=s.id) AS message_count
    FROM experiment_sessions s WHERE s.participant_id=$1 AND s.experiment_id=$2 ORDER BY s.started_at DESC,s.id DESC`,[participantId,experimentId]);
  const list = sessions.rows.map(row=>({id:row.public_id,status:row.status,startedAt:row.started_at,lastActivityAt:row.last_activity_at,
    completedAt:row.completed_at,experimentRunId:row.experiment_run_id,agentId:row.agent_id,
    title:String(row.metadata.conversation_title ?? "新对话"),turnCount:Number(row.turn_count),messageCount:Number(row.message_count),
    interactionId:row.metadata.interaction_id ?? null,memory:row.metadata.history_memory ?? null}));
  if (!publicSessionId) return {sessions:list};
  const selected = sessions.rows.find(row=>row.public_id===publicSessionId);
  if (!selected) throw new ApiError(404,"CONVERSATION_NOT_FOUND","此会话不属于当前项目和被试。");
  const messages = await query<{id:string;role:string;content:string;sequence_no:number;sent_at:string}>(
    "SELECT id,role,content,sequence_no,sent_at FROM messages WHERE session_id=$1 ORDER BY sequence_no,id",[selected.id]);
  return {sessions:list,session:list.find(row=>row.id===publicSessionId),draft:selected.draft_text,
    messages:messages.rows.map(row=>({id:row.id,role:row.role,content:row.content,sequenceNo:row.sequence_no,sentAt:row.sent_at}))};
}

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
