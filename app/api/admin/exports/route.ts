import { z } from "zod";
import { experiment } from "@/config/experiment";
import { buildIdentityMappingCsv, buildInteractionArchive } from "@/lib/admin-export";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";

export const runtime = "nodejs";
export const maxDuration = 60;

const exportSchema = z.object({
  kind: z.enum(["interactions_zip", "identity_csv"]),
  participantIds: z.array(z.uuid()).min(1).max(500).transform((ids) => [...new Set(ids)]),
});

function exportError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "PARTICIPANTS_NOT_FOUND") {
    return new ApiError(400, message, "部分参与者不存在或已被删除，请刷新列表后重新选择。");
  }
  return error;
}

function downloadHeaders(contentType: string, filename: string) {
  return {
    "Content-Type": contentType,
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = exportSchema.safeParse(await request.json().catch(() => null));
    if (!input.success) throw new ApiError(400, "INVALID_EXPORT_REQUEST", "请选择至少一位有效参与者。一次最多导出 500 位。");

    if (input.data.kind === "identity_csv") {
      const file = await buildIdentityMappingCsv({
        experimentId: experiment.id,
        participantIds: input.data.participantIds,
        adminUserId: admin.id,
      });
      return new Response(file.content, { headers: downloadHeaders("text/csv; charset=utf-8", file.filename) });
    }

    const archive = await buildInteractionArchive({
      experimentId: experiment.id,
      participantIds: input.data.participantIds,
      adminUserId: admin.id,
    });
    return new Response(Uint8Array.from(archive.bytes).buffer, {
      headers: downloadHeaders("application/zip", archive.filename),
    });
  } catch (error) {
    return errorResponse(exportError(error));
  }
}
