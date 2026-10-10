import "server-only";

import { query } from "@/db";
import { experiment } from "@/config/experiment";
import { ApiError } from "@/lib/http";
import type { ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import { SESSION_COOKIE } from "@/lib/security";
import { normalizeEntryToken } from "@/lib/entry-links";
import { RESERVED_ENTRY_TOKENS_SQL } from "@/lib/entry-token";

export interface ExperimentEntry {
  token: string;
  experimentId: string;
  runId: string;
  status: "draft" | "active" | "closed";
  snapshot: ExperimentSessionSnapshot | null;
}

export async function getExperimentEntry(token: string): Promise<ExperimentEntry> {
  const normalized = normalizeEntryToken(token);
  if (!normalized) throw new ApiError(404, "ENTRY_NOT_FOUND", "实验链接不存在，请检查教师提供的链接。");
  type EntryRow = { id: string; experiment_id: string; entry_token: string; status: ExperimentEntry["status"]; config_snapshot: ExperimentSessionSnapshot | null };
  const result = await query<EntryRow>(
    `SELECT id, experiment_id, entry_token, status, config_snapshot FROM experiment_runs
     WHERE entry_token=$1 AND entry_deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM (${RESERVED_ENTRY_TOKENS_SQL}) reserved
         WHERE reserved.entry_token=$1 AND reserved.run_id<>experiment_runs.id::text)`, [normalized]);
  let row = result.rows[0];
  // Only legacy links need an alias lookup; current four-character links use
  // the existing unique index. The session remains bound to the same run.
  if (!row && normalized.length !== 4) {
    const legacy = await query<EntryRow>(`SELECT id, experiment_id, entry_token, status, config_snapshot
      FROM experiment_runs WHERE entry_deleted_at IS NULL AND metadata->'entry_token_aliases' ? $1`, [normalized]);
    row = legacy.rows[0];
  }
  if (!row) throw new ApiError(404, "ENTRY_NOT_FOUND", "实验链接不存在，请检查教师提供的链接。");
  return { token: row.entry_token, experimentId: row.experiment_id, runId: row.id, status: row.status, snapshot: row.config_snapshot };
}

export async function getStudentEntry(request?: Request) {
  const token = request ? new URL(request.url).searchParams.get("entry") : null;
  return token === null ? null : getExperimentEntry(token);
}

export function sessionCookieName(entry?: ExperimentEntry | null) {
  return entry ? `${SESSION_COOKIE}_${entry.runId.replaceAll("-", "")}` : SESSION_COOKIE;
}

export async function getAdminExperimentId(request?: Request) {
  const id = request ? new URL(request.url).searchParams.get("experimentId") : null;
  if (id === null || id === experiment.id) return experiment.id;
  if (!/^[a-zA-Z0-9_-]{2,80}$/.test(id)) throw new ApiError(400, "INVALID_EXPERIMENT", "实验标识无效。");
  const found = await query("SELECT id FROM experiments WHERE id=$1", [id]);
  if (!found.rows[0]) throw new ApiError(404, "EXPERIMENT_NOT_FOUND", "找不到所选实验。");
  return id;
}

export async function assertAdminRun(experimentId: string, runId?: string | null) {
  if (!runId) return null;
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new ApiError(400,"INVALID_RUN","场次标识无效。");
  const result = await query("SELECT id FROM experiment_runs WHERE id=$1 AND experiment_id=$2", [runId,experimentId]);
  if (!result.rows[0]) throw new ApiError(404,"RUN_NOT_FOUND","此场次不属于当前实验。");
  return runId;
}
