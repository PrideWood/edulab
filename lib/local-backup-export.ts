import "server-only";

import { strToU8, zipSync } from "fflate";
import { query } from "@/db";
import { ApiError } from "@/lib/http";

export type LocalBackupReference = { deviceId: string; participantId: string };
const MAX_BYTES = 64 * 1024 * 1024;

function segment(value: string, fallback: string) {
  return Array.from(value.normalize("NFC")).filter(char => char.charCodeAt(0) >= 32)
    .join("").replace(/[<>:"/\\|?*]/g, "_").replace(/\.{2,}/g, "_")
    .replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 60) || fallback;
}

export async function buildLocalBackupZip(references: LocalBackupReference[]) {
  const normalized = references.map(row => ({ deviceId: row.deviceId.toLowerCase(), participantId: row.participantId.toLowerCase() }));
  const selected = [...new Map(normalized.map(row => [`${row.deviceId}:${row.participantId}`, row])).values()];
  const ready = await query<{ relation: string | null }>("SELECT to_regclass('edulab_local_backup.latest_participants')::text AS relation");
  if (!ready.rows[0]?.relation) throw new ApiError(404, "LOCAL_BACKUPS_NOT_INITIALIZED", "当前数据库尚未接入本地版备份。");
  // Resolve exact composite identities and one latest snapshot per participant in
  // a single database statement. Check total size before transferring archives.
  const result = await query<{ device_id: string | null; participant_id: string | null;
    participant_name: string; class_code: string; source_app: string;
    archive: Record<string, unknown>; selected_count: string; total_bytes: string }>(`
    WITH selected AS MATERIALIZED (
      SELECT p.device_id,p.participant_id,p.participant_name,p.class_code,p.source_app,p.archive
      FROM edulab_local_backup.latest_participants p
      JOIN unnest($1::uuid[],$2::uuid[]) AS requested(device_id,participant_id)
        ON p.device_id=requested.device_id AND p.participant_id=requested.participant_id
    ), budget AS (
      SELECT count(*)::text AS selected_count,coalesce(sum(octet_length(archive::text)),0)::text AS total_bytes FROM selected
    )
    SELECT selected.*,budget.selected_count,budget.total_bytes
    FROM budget LEFT JOIN selected ON budget.total_bytes::bigint <= $3
    ORDER BY selected.source_app,selected.class_code,selected.device_id,selected.participant_id`,
    [selected.map(row => row.deviceId), selected.map(row => row.participantId), MAX_BYTES]);
  const count = Number(result.rows[0]?.selected_count ?? 0);
  if (count !== selected.length) throw new ApiError(404, "LOCAL_BACKUP_NOT_FOUND", "部分备份已不存在，请刷新列表后重新选择；本次未导出不完整压缩包。");
  if (Number(result.rows[0]?.total_bytes ?? 0) > MAX_BYTES) throw new ApiError(413, "LOCAL_BACKUP_EXPORT_TOO_LARGE", "所选记录较大，请减少勾选人数后分批导出。");
  const files: Record<string, Uint8Array> = {};
  let bytes = 0;
  for (const row of result.rows) {
    const content = strToU8(JSON.stringify(row.archive, null, 2));
    bytes += content.byteLength;
    if (bytes > MAX_BYTES) throw new ApiError(413, "LOCAL_BACKUP_EXPORT_TOO_LARGE", "所选记录较大，请减少勾选人数后分批导出。");
    const source = row.source_app === "teacher-lan" ? "教师机局域网" : "学生机轻量版";
    const name = `${source}/${segment(row.class_code, "未分班")}/${segment(row.participant_name, "参与者")}__${row.device_id}__${row.participant_id}.json`;
    files[name] = content;
  }
  const zip = zipSync(files, { level: 4 });
  // Leave headroom under Vercel's buffered response size limit.
  if (zip.byteLength > 4_000_000) throw new ApiError(413, "LOCAL_BACKUP_EXPORT_TOO_LARGE", "压缩文件较大，请减少勾选人数后分批导出。");
  return { bytes: zip, count, filename: `EduLab_local_interactions_${new Date().toISOString().replace(/[:.]/g, "-")}.zip` };
}
