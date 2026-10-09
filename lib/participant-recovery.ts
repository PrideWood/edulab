import "server-only";

import { query, transaction } from "@/db";
import { experiment } from "@/config/experiment";
import { ApiError } from "@/lib/http";
import { profileFromRow } from "@/lib/participant-profile";
import { hashSecret, newSessionSecret, normalizeParticipantCode } from "@/lib/security";
import type { ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import type { AuthenticatedSession } from "@/lib/session";

export async function recoverParticipant(code: string, identity: string) {
  const participantCode = normalizeParticipantCode(code);
  // Database-backed throttling also works across serverless instances. Never
  // store the submitted identity or IP in this table.
  const attempt = await query<{ attempts: number }>(
    `INSERT INTO participant_recovery_attempts (bucket_hash) VALUES ($1)
     ON CONFLICT (bucket_hash) DO UPDATE SET
       attempts = CASE WHEN participant_recovery_attempts.window_started_at < now() - interval '15 minutes'
         THEN 1 ELSE participant_recovery_attempts.attempts + 1 END,
       window_started_at = CASE WHEN participant_recovery_attempts.window_started_at < now() - interval '15 minutes'
         THEN now() ELSE participant_recovery_attempts.window_started_at END
     RETURNING attempts`, [hashSecret(`${experiment.id}:${participantCode}`)],
  );
  if (attempt.rows[0].attempts > 5) throw new ApiError(429, "RECOVERY_RATE_LIMIT", "此编号恢复尝试过多，请等待 15 分钟或联系教师。");

  return transaction(async (client) => {
    const participant = await client.query<{ id: string }>(
      "SELECT id FROM participants WHERE experiment_id=$1 AND external_code=$2 FOR UPDATE",
      [experiment.id, participantCode],
    );
    const invalid = () => new ApiError(404, "RECOVERY_NOT_FOUND", "编号不存在或身份校验不匹配，请检查编号及原学号（未填学号时使用原姓名）。");
    if (!participant.rows[0]) throw invalid();
    const participantId = participant.rows[0].id;
    const profiles = await client.query("SELECT * FROM participant_identity_profiles WHERE participant_id=$1", [participantId]);
    if (!profiles.rows[0]) throw new ApiError(409, "RECOVERY_IDENTITY_REQUIRED", "此历史记录没有身份信息，请联系教师核验，无法仅凭编号恢复。");
    const profile = profileFromRow(profiles.rows[0]);
    if (identity.trim() !== (profile.studentNumber || profile.fullName)) throw invalid();
    const sessions = await client.query<{
      id: string; public_id: string; status: "active" | "completed"; coze_user_id: string;
      coze_conversation_id: string | null; active_request_id: string | null;
      started_at: string; last_activity_at: string; config_version: number | null;
      config_snapshot: ExperimentSessionSnapshot | null; session_secret_hash: string;
    }>(`SELECT s.* FROM experiment_sessions s WHERE participant_id=$1 AND experiment_id=$2
        ORDER BY COALESCE(s.public_id::text = (SELECT metadata->>'resume_session_id' FROM participants WHERE id=$1), false) DESC,
          last_activity_at DESC, started_at DESC, id DESC LIMIT 1 FOR UPDATE`, [participantId, experiment.id]);
    const row = sessions.rows[0];
    if (!row) throw invalid();
    if (!row.config_snapshot) throw new ApiError(409, "RECOVERY_CONFIG_MISSING", "此历史实验缺少配置快照，请联系教师处理，系统不会重新分组。");
    if (!row.config_snapshot.storage?.databaseMessagesEnabled) throw new ApiError(409, "RECOVERY_STORAGE_DISABLED", "此实验未启用数据库对话存储，无法完整恢复，请联系教师。");
    if (!row.coze_conversation_id) {
      const context = await client.query<{ conversation_id: string | null; has_history: boolean }>(
        `SELECT (SELECT coze_conversation_id FROM chat_requests WHERE session_id=$1
            AND coze_conversation_id IS NOT NULL ORDER BY turn_index DESC LIMIT 1) AS conversation_id,
          (EXISTS (SELECT 1 FROM messages WHERE session_id=$1 AND role='assistant')
            OR EXISTS (SELECT 1 FROM chat_requests WHERE session_id=$1 AND status='completed')) AS has_history`, [row.id]);
      row.coze_conversation_id = context.rows[0].conversation_id;
      if (!row.coze_conversation_id && context.rows[0].has_history) {
        throw new ApiError(409, "RECOVERY_CONTEXT_MISSING", "此历史记录缺少 AI 上下文标识，请联系教师处理，系统不会以空白上下文继续实验。");
      }
      if (row.coze_conversation_id) await client.query("UPDATE experiment_sessions SET coze_conversation_id=$2 WHERE id=$1", [row.id, row.coze_conversation_id]);
    }
    const secret = newSessionSecret();
    const secretHash = hashSecret(secret);
    // Rotate the existing family together, keeping its counts, start time,
    // conversations and assignments. Earlier browsers lose write access.
    await client.query(`UPDATE experiment_sessions SET session_secret_hash=$3,
      metadata=metadata || jsonb_build_object('last_recovered_at', now(), 'recovery_count', COALESCE((metadata->>'recovery_count')::integer, 0) + 1),
      last_activity_at=CASE WHEN id=$4 THEN now() ELSE last_activity_at END
      WHERE participant_id=$1 AND session_secret_hash=$2`, [participantId, row.session_secret_hash, secretHash, row.id]);
    const session: AuthenticatedSession = {
      id: row.id, publicId: row.public_id, participantId, participantCode,
      experimentId: experiment.id, status: row.status, cozeUserId: row.coze_user_id,
      cozeConversationId: row.coze_conversation_id, activeRequestId: row.active_request_id,
      startedAt: row.started_at, lastActivityAt: row.last_activity_at,
      configVersion: row.config_version, configSnapshot: row.config_snapshot, sessionSecretHash: secretHash,
    };
    return { session, secret };
  });
}
