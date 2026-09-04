import "server-only";

import { randomUUID } from "node:crypto";
import { strToU8, zipSync } from "fflate";
import type { PoolClient } from "pg";
import { experiment as defaultExperiment, type ExperimentConfig } from "@/config/experiment";
import { transaction } from "@/db";
import type { StoredMessage } from "@/db/schema";
import type { ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import { profileFromRow } from "@/lib/participant-profile";
import { buildTranscriptExport, safeExportSegment } from "@/lib/transcript-export";

interface ParticipantExportRow {
  id: string;
  external_code: string;
  created_at: Date | string;
}

interface ParticipantIdentityRow extends ParticipantExportRow {
  full_name_ciphertext: string | null;
  full_name_iv: string | null;
  full_name_tag: string | null;
  student_number_ciphertext: string | null;
  student_number_iv: string | null;
  student_number_tag: string | null;
  updated_at: Date | string | null;
}

interface SessionExportRow {
  id: string;
  public_id: string;
  participant_id: string;
  status: string;
  started_at: Date | string;
  last_activity_at: Date | string;
  coze_conversation_id: string | null;
  experiment_run_id: string | null;
  agent_id: string | null;
  config_snapshot: unknown;
}

interface MessageExportRow {
  id: string;
  session_id: string;
  sequence_no: number;
  turn_index: number;
  role: "user" | "assistant";
  content: string;
  sent_at: Date | string;
  reply_started_at: Date | string | null;
  reply_completed_at: Date | string | null;
  latency_ms: number | null;
  client_request_id: string | null;
  coze_message_id: string | null;
  coze_chat_id: string | null;
}

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIso(value: Date | string | null) {
  return value ? iso(value) : null;
}

function exportStamp(value: string) {
  return value.replaceAll(":", "-").replace(".", "-");
}

function csvCell(value: string) {
  const safeValue = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safeValue.replaceAll('"', '""')}"`;
}

function sessionSnapshot(value: unknown): ExperimentSessionSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ExperimentSessionSnapshot>;
  if (!candidate.experiment || typeof candidate.experiment !== "object") return null;
  return candidate as ExperimentSessionSnapshot;
}

function storedMessage(row: MessageExportRow): StoredMessage {
  return {
    id: row.id,
    sequenceNo: row.sequence_no,
    turnIndex: row.turn_index,
    role: row.role,
    content: row.content,
    sentAt: iso(row.sent_at),
    replyStartedAt: nullableIso(row.reply_started_at),
    replyCompletedAt: nullableIso(row.reply_completed_at),
    latencyMs: row.latency_ms,
    clientRequestId: row.client_request_id,
    cozeMessageId: row.coze_message_id,
    cozeChatId: row.coze_chat_id,
    status: "completed",
  };
}

async function selectedParticipants(client: PoolClient, experimentId: string, participantIds: string[]) {
  const result = await client.query<ParticipantExportRow>(
    `SELECT id, external_code, created_at
     FROM participants
     WHERE experiment_id = $1 AND id = ANY($2::uuid[])
     ORDER BY external_code`,
    [experimentId, participantIds],
  );
  if (result.rows.length !== participantIds.length) throw new Error("PARTICIPANTS_NOT_FOUND");
  return result.rows;
}

async function recordExportAudit(client: PoolClient, input: {
  adminUserId: string;
  experimentId: string;
  action: string;
  participantIds: string[];
  participantCodes: string[];
  sessionCount?: number;
  messageCount?: number;
}) {
  await client.query(
    `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, after_data)
     VALUES ($1,$2,$3,$4,$5::jsonb)`,
    [randomUUID(), input.adminUserId, input.action, input.experimentId, JSON.stringify({
      participantIds: input.participantIds,
      participantCodes: input.participantCodes,
      participantCount: input.participantIds.length,
      sessionCount: input.sessionCount,
      messageCount: input.messageCount,
    })],
  );
}

export async function buildInteractionArchive(input: {
  experimentId: string;
  participantIds: string[];
  adminUserId: string;
}) {
  const exportedAt = new Date().toISOString();
  return transaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const participants = await selectedParticipants(client, input.experimentId, input.participantIds);
    const sessions = (await client.query<SessionExportRow>(
      `SELECT id, public_id, participant_id, status, started_at, last_activity_at,
         coze_conversation_id, experiment_run_id, agent_id, config_snapshot
       FROM experiment_sessions
       WHERE experiment_id = $1 AND participant_id = ANY($2::uuid[])
       ORDER BY participant_id, started_at, id`,
      [input.experimentId, input.participantIds],
    )).rows;
    const sessionIds = sessions.map((session) => session.id);
    const messages = sessionIds.length === 0 ? [] : (await client.query<MessageExportRow>(
      `SELECT id, session_id, sequence_no, turn_index, role, content, sent_at,
         reply_started_at, reply_completed_at, latency_ms, client_request_id,
         coze_message_id, coze_chat_id
       FROM messages
       WHERE session_id = ANY($1::uuid[])
       ORDER BY session_id, sequence_no, sent_at, id`,
      [sessionIds],
    )).rows;
    const messagesBySession = new Map<string, StoredMessage[]>();
    for (const message of messages) {
      const group = messagesBySession.get(message.session_id) ?? [];
      group.push(storedMessage(message));
      messagesBySession.set(message.session_id, group);
    }

    const files: Record<string, Uint8Array> = {};
    const manifestParticipants = participants.map((participant) => {
      const participantSessions = sessions.filter((session) => session.participant_id === participant.id);
      return {
        participantCode: participant.external_code,
        sessionCount: participantSessions.length,
        sessions: participantSessions.map((session) => {
          const sessionMessages = messagesBySession.get(session.id) ?? [];
          return {
            sessionId: session.public_id,
            status: session.status,
            startedAt: iso(session.started_at),
            lastActivityAt: iso(session.last_activity_at),
            messageCount: sessionMessages.length,
            turnCount: new Set(sessionMessages.map((message) => message.turnIndex)).size,
            databaseRecordStatus: session.status === "completed" ? "complete" : "possibly_incomplete",
          };
        }),
      };
    });

    for (const participant of participants) {
      for (const session of sessions.filter((item) => item.participant_id === participant.id)) {
        const snapshot = sessionSnapshot(session.config_snapshot);
        const experiment: ExperimentConfig = snapshot?.experiment ?? { ...defaultExperiment, id: input.experimentId };
        const record = buildTranscriptExport({
          exportedAt,
          session: {
            id: session.public_id,
            status: session.status === "completed" ? "completed" : "active",
            startedAt: iso(session.started_at),
            lastActivityAt: iso(session.last_activity_at),
            participantCode: participant.external_code,
            cozeConversationId: session.coze_conversation_id,
            experimentRunId: session.experiment_run_id,
            agentId: session.agent_id,
          },
          experiment,
          databaseMessagesEnabled: snapshot?.storage?.databaseMessagesEnabled ?? true,
          browserBackupIncluded: false,
          messages: messagesBySession.get(session.id) ?? [],
        });
        const participantFolder = safeExportSegment(participant.external_code, "participant");
        files[`interactions/${participantFolder}/session_${session.public_id}.json`] = strToU8(JSON.stringify(record, null, 2));
      }
    }

    const incompleteSessionCount = sessions.filter((session) => session.status !== "completed").length;
    const emptySessionCount = sessions.filter((session) => (messagesBySession.get(session.id)?.length ?? 0) === 0).length;
    const manifest = {
      schemaVersion: 1,
      type: "edulab-admin-interaction-export",
      exportedAt,
      source: "postgresql",
      experimentId: input.experimentId,
      participantCount: participants.length,
      sessionCount: sessions.length,
      messageCount: messages.length,
      completeness: {
        incompleteSessionCount,
        emptySessionCount,
        note: "active Session 或零消息 Session 可能尚未从参与者浏览器完成数据库备份。",
      },
      participants: manifestParticipants,
    };
    files["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));

    await recordExportAudit(client, {
      adminUserId: input.adminUserId,
      experimentId: input.experimentId,
      action: "experiment.records.export",
      participantIds: participants.map((participant) => participant.id),
      participantCodes: participants.map((participant) => participant.external_code),
      sessionCount: sessions.length,
      messageCount: messages.length,
    });
    return {
      bytes: zipSync(files, { level: 6 }),
      filename: `EduLab_interactions_${exportStamp(exportedAt)}.zip`,
    };
  });
}

export async function buildIdentityMappingCsv(input: {
  experimentId: string;
  participantIds: string[];
  adminUserId: string;
}) {
  const exportedAt = new Date().toISOString();
  return transaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const participants = await selectedParticipants(client, input.experimentId, input.participantIds);
    const identities = (await client.query<ParticipantIdentityRow>(
      `SELECT p.id, p.external_code, p.created_at,
         profile.full_name_ciphertext, profile.full_name_iv, profile.full_name_tag,
         profile.student_number_ciphertext, profile.student_number_iv, profile.student_number_tag,
         profile.updated_at
       FROM participants p
       LEFT JOIN participant_identity_profiles profile ON profile.participant_id = p.id
       WHERE p.experiment_id = $1 AND p.id = ANY($2::uuid[])
       ORDER BY p.external_code`,
      [input.experimentId, input.participantIds],
    )).rows;
    const rows = [
      ["Participant ID", "姓名", "学号", "信息更新时间", "参与者创建时间"],
      ...identities.map((row) => {
        const profile = row.updated_at ? profileFromRow({ ...row, updated_at: iso(row.updated_at) }) : null;
        return [row.external_code, profile?.fullName ?? "", profile?.studentNumber ?? "", profile?.updatedAt ?? "", iso(row.created_at)];
      }),
    ];
    const csv = `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}\r\n`;
    await recordExportAudit(client, {
      adminUserId: input.adminUserId,
      experimentId: input.experimentId,
      action: "participant.identity.export",
      participantIds: participants.map((participant) => participant.id),
      participantCodes: participants.map((participant) => participant.external_code),
    });
    return {
      content: csv,
      filename: `EduLab_identity_mapping_${exportStamp(exportedAt)}.csv`,
    };
  });
}
