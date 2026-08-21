import "server-only";

import { query } from "@/db";
import { buildSessionSnapshot, getExperimentSettings, type ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import { ApiError } from "@/lib/http";
import type { AuthenticatedSession } from "@/lib/session";

export interface SessionControls {
  taskVisible: boolean;
  chatEnabled: boolean;
  maxMessageChars: number;
  maxUserMessages: number | null;
  usedMessages: number;
  remainingMessages: number | null;
  endsAt: string | null;
  databaseMessagesEnabled: boolean;
}

export async function resolveSessionSnapshot(session: AuthenticatedSession): Promise<ExperimentSessionSnapshot> {
  return session.configSnapshot ?? buildSessionSnapshot(await getExperimentSettings(session.experimentId));
}

export async function getSessionControls(session: AuthenticatedSession) {
  const snapshot = await resolveSessionSnapshot(session);
  const databaseMessagesEnabled = snapshot.storage?.databaseMessagesEnabled ?? true;
  const family = await query<{ count: string; started_at: string }>(
    `SELECT count(r.id)::text AS count, min(s.started_at)::text AS started_at
     FROM experiment_sessions s
     LEFT JOIN chat_requests r ON r.session_id = s.id
     WHERE s.participant_id = $1 AND s.experiment_id = $2 AND s.session_secret_hash = $3`,
    [session.participantId, session.experimentId, session.sessionSecretHash],
  );
  const count = family;
  const usedMessages = Number(count.rows[0]?.count ?? 0);
  const experimentStartedAt = count.rows[0]?.started_at ?? session.startedAt;
  const endsAt = snapshot.limits.sessionDurationMinutes
    ? new Date(new Date(experimentStartedAt).getTime() + snapshot.limits.sessionDurationMinutes * 60_000)
    : null;
  let status = session.status;
  if (status === "active" && endsAt && endsAt.getTime() <= Date.now() && !session.activeRequestId) {
    await query(
      `UPDATE experiment_sessions SET status = 'completed', completed_at = COALESCE(completed_at, now()),
         last_activity_at = now(), metadata = metadata || '{"end_reason":"time_limit"}'::jsonb
       WHERE id = $1 AND status = 'active' AND active_request_id IS NULL`,
      [session.id],
    );
    status = "completed";
  }
  const max = snapshot.limits.maxUserMessages;
  const controls: SessionControls = {
    taskVisible: snapshot.experiment.taskVisible,
    chatEnabled: snapshot.experiment.chatEnabled,
    maxMessageChars: snapshot.limits.maxMessageChars,
    maxUserMessages: max,
    usedMessages,
    remainingMessages: max === null ? null : Math.max(0, max - usedMessages),
    endsAt: endsAt?.toISOString() ?? null,
    databaseMessagesEnabled,
  };
  return { snapshot, controls, status };
}

export async function assertSessionCanSend(session: AuthenticatedSession, content: string) {
  const identity = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM participant_identity_profiles WHERE participant_id = $1
     ) AS exists`,
    [session.participantId],
  );
  if (!identity.rows[0]?.exists) throw new ApiError(409, "PARTICIPANT_PROFILE_REQUIRED", "请先填写参与者信息。");
  const state = await getSessionControls(session);
  if (state.status !== "active") throw new ApiError(409, "SESSION_COMPLETED", "本次实验已经结束，不能再发送消息。");
  if (!state.controls.chatEnabled) throw new ApiError(403, "CHAT_DISABLED", "本次实验未开放 AI 对话。");
  if (state.controls.endsAt && new Date(state.controls.endsAt).getTime() <= Date.now()) throw new ApiError(409, "TIME_LIMIT_REACHED", "本次实验的交流时间已结束。");
  if (state.controls.remainingMessages !== null && state.controls.remainingMessages <= 0) throw new ApiError(409, "MESSAGE_LIMIT_REACHED", "你已经完成了本次实验允许的交流次数。");
  if (Array.from(content).length > state.controls.maxMessageChars) throw new ApiError(400, "MESSAGE_TOO_LONG", `每条消息最多 ${state.controls.maxMessageChars} 字。`);
  return state;
}
