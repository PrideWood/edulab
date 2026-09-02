import { NextResponse } from "next/server";
import { z } from "zod";
import { experiment } from "@/config/experiment";
import { activateExperimentRun, closeActiveExperimentRun, deleteAgentConfig, getAgentControl, saveAgentConfig } from "@/lib/agent-control";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
}, "API 地址必须使用 HTTPS");

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save_agent"),
    agent: z.object({
      id: z.uuid().optional(),
      internalName: z.string().trim().min(1).max(100),
      baseUrl: httpsUrl,
      botId: z.string().trim().min(1).max(200),
      token: z.string().trim().max(2000).optional(),
      enabled: z.boolean(),
    }),
  }),
  z.object({
    action: z.literal("activate_run"),
    run: z.object({
      name: z.string().trim().min(1).max(120),
      assignmentMode: z.enum(["fixed", "balanced_random"]),
      fixedAgentId: z.uuid().nullable(),
      randomAgentIds: z.array(z.uuid()).max(20),
    }),
  }),
  z.object({ action: z.literal("close_active_run") }),
]);

const deleteSchema = z.object({
  agentId: z.uuid(),
  confirmationName: z.string().trim().min(1).max(100),
});

function controlError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "AGENT_NOT_FOUND") return new ApiError(404, message, "找不到这个智能体配置。");
  if (message === "ACTIVE_AGENT_LOCKED") return new ApiError(409, message, "当前场次正在使用这个智能体。请先结束场次，再修改配置。");
  if (message === "AGENT_HAS_REFERENCES") return new ApiError(409, message, "这个智能体已被场次或历史会话引用，不能删除。可以将它停用，避免用于新场次。");
  if (message === "AGENT_CONFIRMATION_MISMATCH") return new ApiError(400, message, "输入的智能体名称不一致，未执行删除。");
  if (message === "INVALID_RUN_AGENTS") return new ApiError(400, message, "请选择符合分配规则且已经启用的智能体。");
  return error;
}

export async function GET() {
  try {
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    return NextResponse.json({ control: await getAgentControl(experiment.id) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_AGENT_CONTROL", input.error.issues[0]?.message ?? "智能体或场次设置无效。");
    if (input.data.action === "save_agent") {
      await saveAgentConfig({ ...input.data.agent, experimentId: experiment.id }, admin.id);
    } else if (input.data.action === "activate_run") {
      await activateExperimentRun({ ...input.data.run, experimentId: experiment.id }, admin.id);
    } else {
      await closeActiveExperimentRun(experiment.id, admin.id);
    }
    return NextResponse.json({ control: await getAgentControl(experiment.id) });
  } catch (error) { return errorResponse(controlError(error)); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = deleteSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_AGENT_DELETE", "删除确认信息无效。");
    await deleteAgentConfig({ ...input.data, experimentId: experiment.id }, admin.id);
    return NextResponse.json({ control: await getAgentControl(experiment.id) });
  } catch (error) { return errorResponse(controlError(error)); }
}
