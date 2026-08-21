import "server-only";

import { cookies } from "next/headers";
import { query } from "@/db";
import { hashSecret, parseSessionCookie, SESSION_COOKIE } from "@/lib/security";
import type { ExperimentSessionSnapshot } from "@/lib/experiment-settings";

export interface AuthenticatedSession {
  id: string;
  publicId: string;
  participantId: string;
  participantCode: string;
  experimentId: string;
  status: "active" | "completed";
  cozeUserId: string;
  cozeConversationId: string | null;
  activeRequestId: string | null;
  startedAt: string;
  lastActivityAt: string;
  configVersion: number | null;
  configSnapshot: ExperimentSessionSnapshot | null;
  sessionSecretHash: string;
}

export async function getAuthenticatedSession(): Promise<AuthenticatedSession | null> {
  const parsed = parseSessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
  if (!parsed) return null;
  const result = await query<{
    id: string; public_id: string; participant_id: string; external_code: string;
    experiment_id: string; status: "active" | "completed"; coze_user_id: string;
    coze_conversation_id: string | null; active_request_id: string | null;
    started_at: string; last_activity_at: string; config_version: number | null;
    config_snapshot: ExperimentSessionSnapshot | null; session_secret_hash: string;
  }>(`SELECT s.id, s.public_id, s.participant_id, p.external_code, s.experiment_id,
             s.status, s.coze_user_id, s.coze_conversation_id, s.active_request_id,
             s.started_at, s.last_activity_at, s.config_version, s.config_snapshot, s.session_secret_hash
      FROM experiment_sessions s
      JOIN participants p ON p.id = s.participant_id
      WHERE s.public_id = $1 AND s.session_secret_hash = $2`, [parsed.publicId, hashSecret(parsed.secret)]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: row.id, publicId: row.public_id, participantId: row.participant_id,
    participantCode: row.external_code, experimentId: row.experiment_id,
    status: row.status, cozeUserId: row.coze_user_id,
    cozeConversationId: row.coze_conversation_id, activeRequestId: row.active_request_id,
    startedAt: row.started_at, lastActivityAt: row.last_activity_at,
    configVersion: row.config_version, configSnapshot: row.config_snapshot,
    sessionSecretHash: row.session_secret_hash,
  };
}
