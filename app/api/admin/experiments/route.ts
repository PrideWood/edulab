import { query } from "@/db";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { createExperiment, listExperiments } from "@/lib/experiments";
import { getExperimentSettings, saveExperimentSettings } from "@/lib/experiment-settings";
import { getAdminExperimentId } from "@/lib/experiment-entry";

const inputSchema = z.object({ name: z.string().trim().min(1).max(120), sourceId: z.string().min(2).max(80) });
export async function GET() {
  try {
    if (!await getAuthenticatedAdmin()) throw new ApiError(401,"ADMIN_REQUIRED","请先登录管理后台。");
    return NextResponse.json({ experiments: await listExperiments() }, { headers: { "Cache-Control":"private, no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401,"ADMIN_REQUIRED","请先登录管理后台。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400,"INVALID_EXPERIMENT","请填写实验名称并选择复制来源。");
    await getAdminExperimentId(new Request(`${new URL(request.url).origin}/api/admin/experiments?experimentId=${encodeURIComponent(input.data.sourceId)}`));
    await listExperiments();
    // Ensure the legacy environment-only experiment has a persisted template.
    const settings = await getExperimentSettings(input.data.sourceId, false);
    const persisted = await query("SELECT experiment_id FROM experiment_settings WHERE experiment_id=$1", [input.data.sourceId]);
    if (!persisted.rows[0]) await saveExperimentSettings({ ...settings, ai: { baseUrl: settings.ai.baseUrl, botId: settings.ai.botId } }, admin.id);
    const created = await createExperiment(input.data.name,input.data.sourceId,admin.id);
    return NextResponse.json({ created, experiments: await listExperiments() }, { status:201 });
  } catch (error) { return errorResponse(error); }
}
