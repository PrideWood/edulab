import { z } from "zod";
import { getAuthenticatedAdmin } from "@/lib/admin-auth";
import { getLocalBackup, listLocalBackups } from "@/lib/local-backups";
import { ApiError, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
const filterSchema = z.object({
  source: z.enum(["student-light", "teacher-lan"]).optional(),
  classCode: z.string().max(30).optional(), search: z.string().max(100).optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  deviceId: z.uuid().optional(), participantId: z.uuid().optional(),
  download: z.enum(["1"]).optional(),
}).refine(value => Boolean(value.deviceId) === Boolean(value.participantId), "需要完整记录标识");

export async function GET(request: Request) {
  try {
    if (!await getAuthenticatedAdmin()) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = filterSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!input.success) throw new ApiError(400, "INVALID_LOCAL_BACKUP_FILTER", "备份筛选条件或记录标识无效。");
    const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
    const { deviceId, participantId, download } = input.data;
    if (deviceId && participantId) {
      const archive = await getLocalBackup(deviceId, participantId);
      if (download) return new Response(JSON.stringify(archive, null, 2), { headers: { ...headers,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="EduLab-local-${deviceId.slice(0,8)}-${participantId}.json"` } });
      return Response.json({ archive }, { headers });
    }
    return Response.json(await listLocalBackups(input.data), { headers });
  } catch (error) { return errorResponse(error); }
}
