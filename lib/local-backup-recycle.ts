import "server-only";

import { randomUUID } from "node:crypto";
import { transaction } from "@/db";
import { ApiError } from "@/lib/http";
import type { LocalBackupReference } from "@/lib/local-backup-export";

export async function setLocalBackupsRecycled(records: LocalBackupReference[], action: "trash" | "restore", adminId: string) {
  const normalized = records.map(row => ({ deviceId: row.deviceId.toLowerCase(), participantId: row.participantId.toLowerCase() }));
  const selected = [...new Map(normalized.map(row => [`${row.deviceId}:${row.participantId}`, row])).values()]
    .sort((a, b) => `${a.deviceId}:${a.participantId}`.localeCompare(`${b.deviceId}:${b.participantId}`));
  return transaction(async client => {
    const ready = await client.query<{ backups: string | null; disposition: string | null }>(
      "SELECT to_regclass('edulab_local_backup.latest_participants')::text AS backups,to_regclass('public.local_backup_dispositions')::text AS disposition");
    if (!ready.rows[0]?.backups) throw new ApiError(404, "LOCAL_BACKUPS_NOT_INITIALIZED", "当前数据库尚未接入本地版备份。");
    if (!ready.rows[0]?.disposition) throw new ApiError(503, "LOCAL_RECYCLE_BIN_NOT_INITIALIZED", "回收站尚未初始化，请先执行 0018 数据库迁移。");
    const devices = selected.map(row => row.deviceId), people = selected.map(row => row.participantId);
    // Consistent identity lock order serializes overlapping trash/restore batches.
    // The append-only local uploader is intentionally independent of these locks.
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('local-backup-disposition:' || device_id::text || ':' || participant_id::text,0))
      FROM (SELECT * FROM unnest($1::uuid[],$2::uuid[]) AS r(device_id,participant_id) ORDER BY device_id,participant_id) ordered`, [devices, people]);
    const found = await client.query<{ device_id: string; participant_id: string }>(`
      SELECT p.device_id,p.participant_id FROM edulab_local_backup.latest_participants p
      JOIN unnest($1::uuid[],$2::uuid[]) AS r(device_id,participant_id)
        ON p.device_id=r.device_id AND p.participant_id=r.participant_id`, [devices, people]);
    if (found.rows.length !== selected.length) throw new ApiError(404, "LOCAL_BACKUP_NOT_FOUND", "部分备份已不存在，请刷新列表；本次操作未修改任何记录。");
    let changed: number;
    if (action === "trash") {
      const result = await client.query(`INSERT INTO public.local_backup_dispositions(device_id,participant_id,is_trashed,trashed_at,trashed_by)
        SELECT device_id,participant_id,true,now(),$3 FROM unnest($1::uuid[],$2::uuid[]) AS r(device_id,participant_id)
        ORDER BY device_id,participant_id
        ON CONFLICT(device_id,participant_id) DO UPDATE SET is_trashed=true,trashed_at=now(),trashed_by=$3,
          restored_at=NULL,restored_by=NULL,updated_at=now()
        WHERE NOT local_backup_dispositions.is_trashed RETURNING device_id`, [devices, people, adminId]);
      changed = result.rowCount ?? 0;
    } else {
      const result = await client.query(`UPDATE public.local_backup_dispositions d SET is_trashed=false,restored_at=now(),restored_by=$3,updated_at=now()
        FROM unnest($1::uuid[],$2::uuid[]) AS r(device_id,participant_id)
        WHERE d.device_id=r.device_id AND d.participant_id=r.participant_id AND d.is_trashed RETURNING d.device_id`, [devices, people, adminId]);
      changed = result.rowCount ?? 0;
    }
    if (changed) await client.query(`INSERT INTO admin_audit_log(id,admin_user_id,action,after_data) VALUES($1,$2,$3,$4::jsonb)`,
      [randomUUID(), adminId, `local.backup.${action}`, JSON.stringify({ records: selected, changedCount: changed })]);
    return { action, selectedCount: selected.length, changedCount: changed };
  });
}
