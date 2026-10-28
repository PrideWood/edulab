import { z } from "zod";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { getLocalBackup, listLocalBackups, listLocalBackupSelection } from "@/lib/local-backups";
import { buildLocalBackupZip } from "@/lib/local-backup-export";
import { setLocalBackupsRecycled } from "@/lib/local-backup-recycle";
import { ApiError, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;
const filterSchema = z.object({
  source: z.enum(["student-light", "teacher-lan"]).optional(),
  classCode: z.string().max(30).optional(), search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  deviceId: z.uuid().optional(), participantId: z.uuid().optional(),
  download: z.enum(["1"]).optional(),
  view: z.enum(["active", "trash"]).default("active"),
  selection: z.enum(["all"]).optional(),
}).refine(value => Boolean(value.deviceId) === Boolean(value.participantId), "需要完整记录标识")
  .refine(value => !value.selection || (!value.deviceId && !value.download), "全选不能同时指定单条记录");

const exportSchema = z.object({
  records: z.array(z.object({ deviceId: z.uuid(), participantId: z.uuid(), exportIndex: z.number().int().min(1).max(10000).optional() })).min(1).max(500),
});
const recycleSchema = z.object({
  action: z.enum(["trash", "restore"]),
  records: z.array(z.object({ deviceId: z.uuid(), participantId: z.uuid() })).min(1).max(500),
  confirmation: z.string(),
}).refine(value => value.confirmation === (value.action === "trash" ? "移入回收站" : "恢复记录"));

export async function PATCH(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = recycleSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new ApiError(400, "INVALID_LOCAL_BACKUP_RECYCLE", "请选择 1–500 条有效记录并完成二次确认。");
    return Response.json(await setLocalBackupsRecycled(input.data.records, input.data.action, admin.id), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (!await getAuthenticatedAdmin()) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = exportSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new ApiError(400, "INVALID_LOCAL_BACKUP_EXPORT", "请选择 1–500 条有效备份记录。");
    const file = await buildLocalBackupZip(input.data.records);
    return new Response(Uint8Array.from(file.bytes).buffer, { headers: {
      "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${file.filename}"`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
      "X-EduLab-Export-Count": String(file.count),
    } });
  } catch (error) { return errorResponse(error); }
}

export async function GET(request: Request) {
  try {
    if (!await getAuthenticatedAdmin()) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = filterSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success) throw new ApiError(400, "INVALID_LOCAL_BACKUP_FILTER", "备份筛选条件或记录标识无效。");
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    if (input.data.selection === "all") return Response.json(await listLocalBackupSelection(input.data), { headers });
    const { deviceId, participantId, download, view } = input.data;
    if (deviceId && participantId) {
      if (download && view === "trash") throw new ApiError(409, "LOCAL_BACKUP_IN_TRASH", "回收站中的记录不参与导出，请先恢复记录。");
      const archive = await getLocalBackup(deviceId, participantId, view);
      if (download) return new Response(JSON.stringify(archive, null, 2), { headers: { ...headers,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="EduLab-local-${deviceId.slice(0,8)}-${participantId}.json"` } });
      return Response.json({ archive }, { headers });
    }
    return Response.json(await listLocalBackups(input.data), { headers });
  } catch (error) { return errorResponse(error); }
}
