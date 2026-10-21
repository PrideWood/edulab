import "server-only";

import { transaction } from "@/db";
import type { StoredMessage } from "@/db/schema";
import { experiment as defaultExperiment } from "@/config/experiment";
import type { ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import { ApiError } from "@/lib/http";
import type { AuthenticatedSession } from "@/lib/session";
import { buildTranscriptExport, type ParticipantTranscriptArchive } from "@/lib/transcript-export";

interface ExportSession {
  id: string; public_id: string; status: "active" | "completed";
  started_at: Date | string; last_activity_at: Date | string; completed_at: Date | string | null;
  coze_conversation_id: string | null; dify_conversation_id: string | null;
  experiment_run_id: string | null; agent_id: string | null; active_request_id: string | null;
  config_snapshot: ExperimentSessionSnapshot | null;
  metadata: {conversation_title?:string;interaction_id?:string;previous_session_id?:string;transcript_message_count?:number};
  request_count: number; completed_request_count: number; pending_request_count: number;
}

interface ExportMessage {
  id: string; session_id: string; sequence_no: number; turn_index: number; role: "user" | "assistant";
  content: string; sent_at: Date | string; reply_started_at: Date | string | null; reply_completed_at: Date | string | null;
  latency_ms: number | null; client_request_id: string | null; coze_message_id: string | null; coze_chat_id: string | null;
  metadata: {provider?:"dify";provider_message_id?:string;provider_task_id?:string};
}

function iso(value: Date | string) { return value instanceof Date ? value.toISOString() : new Date(value).toISOString(); }

export async function buildParticipantTranscriptArchive(session: AuthenticatedSession): Promise<ParticipantTranscriptArchive> {
  return transaction(async client => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    const current = await client.query<{experiment_run_id:string | null; external_code:string}>(
      `SELECT s.experiment_run_id,p.external_code FROM experiment_sessions s JOIN participants p ON p.id=s.participant_id
       WHERE s.id=$1 AND s.session_secret_hash=$2 AND s.participant_id=$3 AND s.experiment_id=$4 AND p.experiment_id=$4`,
      [session.id,session.sessionSecretHash,session.participantId,session.experimentId]);
    if (!current.rows[0]) throw new ApiError(401,"SESSION_REPLACED","会话已失效，请使用最近登录的窗口下载记录。");
    const runId = current.rows[0].experiment_run_id;
    const sessions = (await client.query<ExportSession>(
      `SELECT s.id,s.public_id,s.status,s.started_at,s.last_activity_at,s.completed_at,
         s.coze_conversation_id,s.dify_conversation_id,s.experiment_run_id,s.agent_id,s.active_request_id,s.config_snapshot,s.metadata,
         (SELECT count(*)::int FROM chat_requests WHERE session_id=s.id) AS request_count,
         (SELECT count(*)::int FROM chat_requests WHERE session_id=s.id AND status='completed') AS completed_request_count,
         (SELECT count(*)::int FROM chat_requests WHERE session_id=s.id AND status IN ('in_progress','uncertain')) AS pending_request_count
       FROM experiment_sessions s WHERE s.participant_id=$1 AND s.experiment_id=$2
         AND s.experiment_run_id IS NOT DISTINCT FROM $3::uuid
       ORDER BY s.started_at,s.id`,[session.participantId,session.experimentId,runId])).rows;
    const rows = (await client.query<ExportMessage>(
      `SELECT id,session_id,sequence_no,turn_index,role,content,sent_at,reply_started_at,reply_completed_at,
         latency_ms,client_request_id,coze_message_id,coze_chat_id,metadata
       FROM messages WHERE session_id=ANY($1::uuid[]) ORDER BY session_id,sequence_no,sent_at,id`,[sessions.map(row=>row.id)])).rows;
    const bySession = new Map<string, StoredMessage[]>();
    for (const row of rows) {
      const messages = bySession.get(row.session_id) ?? [];
      messages.push({id:row.id,sequenceNo:row.sequence_no,turnIndex:row.turn_index,role:row.role,content:row.content,
        sentAt:iso(row.sent_at),replyStartedAt:row.reply_started_at ? iso(row.reply_started_at) : null,
        replyCompletedAt:row.reply_completed_at ? iso(row.reply_completed_at) : null,latencyMs:row.latency_ms,
        clientRequestId:row.client_request_id,cozeMessageId:row.coze_message_id,cozeChatId:row.coze_chat_id,status:"completed",
        ...(row.metadata?.provider==="dify" ? {provider:"dify",providerMessageId:row.metadata.provider_message_id ?? null,providerTaskId:row.metadata.provider_task_id ?? null} : {})});
      bySession.set(row.session_id,messages);
    }
    const exportedAt = new Date().toISOString();
    const conversations = sessions.map(row => {
      const record = buildTranscriptExport({exportedAt,
        session:{id:row.public_id,status:row.status,startedAt:iso(row.started_at),lastActivityAt:iso(row.last_activity_at),
          participantCode:current.rows[0].external_code,cozeConversationId:row.coze_conversation_id,
          provider:row.config_snapshot?.ai?.provider ?? "coze",difyConversationId:row.dify_conversation_id,
          experimentRunId:row.experiment_run_id,agentId:row.agent_id},
        experiment:row.config_snapshot?.experiment ?? {...defaultExperiment,id:session.experimentId},
        databaseMessagesEnabled:row.config_snapshot?.storage?.databaseMessagesEnabled ?? true,browserBackupIncluded:false,
        messages:bySession.get(row.id) ?? []});
      const pending = Boolean(row.active_request_id || row.pending_request_count);
      return {...record,title:row.metadata.conversation_title || "新对话",completedAt:row.completed_at ? iso(row.completed_at) : null,
        interaction:{id:row.metadata.interaction_id ?? null,previousSessionId:row.metadata.previous_session_id ?? null},
        integrity:{...record.integrity,requestCount:row.request_count,pending,
          possiblyIncomplete:!record.storage.databaseMessagesEnabled || pending
            || row.completed_request_count>record.integrity.participantMessageCount
            || row.completed_request_count>record.integrity.assistantMessageCount
            || (row.metadata.transcript_message_count ?? 0)>record.integrity.messageCount}};
    });
    return {schemaVersion:1,type:"participant-interaction-archive",source:"database",exportedAt,
      participant:{code:current.rows[0].external_code},experimentId:session.experimentId,experimentRunId:runId,currentSessionId:session.publicId,
      integrity:{sessionCount:conversations.length,messageCount:rows.length,
        possiblyIncompleteSessionCount:conversations.filter(record=>record.integrity.possiblyIncomplete).length},conversations};
  });
}
