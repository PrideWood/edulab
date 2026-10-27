import "server-only";

import { query } from "@/db";
import { ApiError } from "@/lib/http";

export type BackupSource = "student-light" | "teacher-lan";
export type LocalBackupRow = {
  deviceId: string; participantId: string; participantName: string; classCode: string;
  sourceApp: BackupSource; isTest: boolean; revision: number;
  conversationCount: number; turnCount: number; messageCount: number;
  exportedAt: string; receivedAt: string; trashedAt: string | null;
};

async function available() {
  const result = await query<{ relation: string | null; recycle_bin: string | null }>("SELECT to_regclass('edulab_local_backup.latest_participants')::text AS relation,to_regclass('public.local_backup_dispositions')::text AS recycle_bin");
  if (!result.rows[0]?.relation) return false;
  if (!result.rows[0]?.recycle_bin) throw new ApiError(503, "LOCAL_RECYCLE_BIN_NOT_INITIALIZED", "回收站尚未初始化，请先执行 0018 数据库迁移。");
  return true;
}

export async function listLocalBackups(input: { source?: BackupSource; classCode?: string; search?: string; page: number; view?: "active" | "trash" }) {
  if (!await available()) return { initialized: false, records: [], total: 0, page: input.page, pageSize: 30 };
  const values = [input.source ?? null, input.classCode ?? null, input.search?.trim() || null, input.view === "trash"];
  const where = `WHERE ($1::text IS NULL OR source_app=$1)
    AND ($2::text IS NULL OR class_code=$2)
    AND ($3::text IS NULL OR position(lower($3) in lower(participant_name))>0)
    AND $4::boolean = EXISTS (SELECT 1 FROM public.local_backup_dispositions d
      WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed)`;
  const [count, result] = await Promise.all([
    query<{ total: string }>(`SELECT count(*)::text AS total FROM edulab_local_backup.latest_participants p ${where}`, values),
    query<{ device_id: string; participant_id: string; participant_name: string; class_code: string;
      source_app: BackupSource; is_test: boolean; revision: string; exported_at: string; received_at: string; trashed_at: string | null;
      conversation_count: number; turn_count: string; message_count: string }>(`
      SELECT device_id,participant_id,participant_name,class_code,source_app,is_test,revision,exported_at,received_at,
        (SELECT d.trashed_at FROM public.local_backup_dispositions d WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed) AS trashed_at,
        jsonb_array_length(archive->'conversations') AS conversation_count,
        (SELECT coalesce(sum(jsonb_array_length(CASE WHEN jsonb_typeof(c->'requests')='array' THEN c->'requests' ELSE '[]'::jsonb END)),0)::text
          FROM jsonb_array_elements(archive->'conversations') c) AS turn_count,
        (SELECT coalesce(sum(jsonb_array_length(CASE WHEN jsonb_typeof(c->'messages')='array' THEN c->'messages' ELSE '[]'::jsonb END)),0)::text
          FROM jsonb_array_elements(archive->'conversations') c) AS message_count
      FROM edulab_local_backup.latest_participants p ${where}
      ORDER BY received_at DESC,device_id,participant_id LIMIT 30 OFFSET $5`, [...values, (input.page - 1) * 30]),
  ]);
  return { initialized: true, total: Number(count.rows[0].total), page: input.page, pageSize: 30,
    records: result.rows.map(row => ({ deviceId: row.device_id, participantId: row.participant_id,
      participantName: row.participant_name, classCode: row.class_code, sourceApp: row.source_app,
      isTest: row.is_test, revision: Number(row.revision), exportedAt: row.exported_at, receivedAt: row.received_at, trashedAt: row.trashed_at,
      conversationCount: row.conversation_count, turnCount: Number(row.turn_count), messageCount: Number(row.message_count) })) };
}

export async function getLocalBackup(deviceId: string, participantId: string, view: "active" | "trash" = "active") {
  if (!await available()) throw new ApiError(404, "LOCAL_BACKUPS_NOT_INITIALIZED", "当前数据库尚未接入本地版备份。");
  const result = await query<{ archive: Record<string, unknown> }>(
    `SELECT archive FROM edulab_local_backup.latest_participants p WHERE device_id=$1 AND participant_id=$2
      AND $3::boolean = EXISTS (SELECT 1 FROM public.local_backup_dispositions d
        WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed)`, [deviceId, participantId, view === "trash"]);
  if (!result.rows[0]) throw new ApiError(404, "LOCAL_BACKUP_NOT_FOUND", "找不到这条本地版备份，请刷新列表。");
  return result.rows[0].archive;
}
