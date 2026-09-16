import { NextResponse } from "next/server";
import { z } from "zod";
import { experiment } from "@/config/experiment";
import { activateExperimentRun, closeActiveExperimentRun, deleteAgentConfig, getAgentControl, resolveAgentTestConnection, saveAgentConfig } from "@/lib/agent-control";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { formatAgentTestFailure } from "@/lib/agent-test-error";
import { testCozeConnection } from "@/lib/coze";
import { ApiError, errorResponse } from "@/lib/http";

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
}, "API 地址必须使用 HTTPS");

const inputSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save_agent"),
    testAfterSave: z.boolean().optional(),
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
    action: z.literal("test_agent"),
    agent: z.object({
      id: z.uuid().optional(),
      baseUrl: httpsUrl,
      botId: z.string().trim().min(1).max(200),
      token: z.string().trim().max(2000).optional(),
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
  if (message === "AGENT_TOKEN_DECRYPT_FAILED") return new ApiError(409, message, "数据库中的 Token 无法解密。请确认本地与 Vercel 的 SETTINGS_ENCRYPTION_KEY 一致且未更换；也可重新输入 Token 并保存。");
  if (message === "ACTIVE_AGENT_LOCKED") return new ApiError(409, message, "当前场次正在使用这个智能体。请先结束场次，再修改配置。");
  if (message === "AGENT_HAS_REFERENCES") return new ApiError(409, message, "这个智能体仍有关联参与者记录或未结束场次。请先清理相关记录并结束场次，再尝试删除。");
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
    if (input.data.action === "test_agent") {
      const connection = await resolveAgentTestConnection({ ...input.data.agent, experimentId: experiment.id });
      try {
        await testCozeConnection({ ...connection, timeoutMs: 20_000 });
      } catch (error) {
        const upstream = error as { status?: number; code?: string };
        const status = upstream.code === "COZE_TEST_TIMEOUT" ? 504
          : upstream.status && [400, 401, 403, 404, 408, 429].includes(upstream.status) ? 422 : 502;
        throw new ApiError(status, "AGENT_CONNECTION_FAILED", formatAgentTestFailure(error, { secret: connection.token }));
      }
      return NextResponse.json({ test: { ok: true, message: "连接成功" } });
    } else if (input.data.action === "save_agent") {
      const saved = await saveAgentConfig({ ...input.data.agent, experimentId: experiment.id }, admin.id);
      if (input.data.testAfterSave) {
        // Read back the committed credential: never test the submitted draft here.
        const connection = await resolveAgentTestConnection({
          id: saved.id, experimentId: experiment.id, baseUrl: saved.baseUrl, botId: saved.botId,
        });
        let test;
        try {
          await testCozeConnection({ ...connection, timeoutMs: 20_000 });
          test = { ok: true, message: "配置已保存，数据库 Token 连接成功。" };
        } catch (error) {
          test = { ok: false, message: "配置已保存，但连接失败：" + formatAgentTestFailure(error, { secret: connection.token }) };
        }
        return NextResponse.json({ control: await getAgentControl(experiment.id), test });
      }
    } else if (input.data.action === "activate_run") {
      await activateExperimentRun({ ...input.data.run, experimentId: experiment.id }, admin.id);
    } else {
      await closeActiveExperimentRun(experiment.id, admin.id);
    }
    return NextResponse.json({ control: await getAgentControl(experiment.id) });
  } catch (error) {
    const controlled = controlError(error);
    if (controlled instanceof Error && controlled.message === "COZE_TOKEN_NOT_CONFIGURED") {
      return errorResponse(new ApiError(400, "COZE_TOKEN_NOT_CONFIGURED", "尚未配置 API Key，请输入 Token 后再测试。"));
    }
    return errorResponse(controlled);
  }
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
