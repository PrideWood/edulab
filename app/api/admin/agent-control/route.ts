import { NextResponse } from "next/server";
import { z } from "zod";
import { getAdminExperimentId } from "@/lib/experiment-entry";
import { activateExperimentRun, closeActiveExperimentRun, deleteAgentConfig, deleteExperimentRunLink, getAgentControl, reopenExperimentRun, resolveAgentTestConnection, saveAgentConfig } from "@/lib/agent-control";
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
      makeDefault: z.boolean().optional(),
    }),
  }),
  z.object({ action: z.literal("close_active_run"), runId: z.uuid().optional() }),
  z.object({ action: z.literal("reopen_run"), runId: z.uuid() }),
  z.object({ action: z.literal("delete_run_link"), runId: z.uuid(), confirmationCode: z.string().trim().min(1).max(32) }),
]);

const deleteSchema = z.object({
  agentId: z.uuid(),
  confirmationName: z.string().trim().min(1).max(100),
});

function controlError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "AGENT_NOT_FOUND") return new ApiError(404, message, "找不到这个智能体配置。");
  if (message === "AGENT_TOKEN_DECRYPT_FAILED") return new ApiError(409, message, "数据库中的 Token 无法解密。请确认本地与 Vercel 的 SETTINGS_ENCRYPTION_KEY 一致且未更换；也可重新输入 Token 并保存。");
  if (message === "ACTIVE_AGENT_LOCKED") return new ApiError(409, message, "开放入口正在使用这个智能体，配置暂时不能修改。请先停止报名；已有实验记录的配置需保留，请新增智能体配置。");
  if (message === "AGENT_RECORDS_LOCKED") return new ApiError(409, message, "这个智能体或其分组已有关联实验记录，停止报名或删除链接后也不能修改。请新增智能体配置并创建新入口。");
  if (message === "AGENT_HAS_REFERENCES") return new ApiError(409, message, "这个智能体仍有关联参与者记录或未结束场次。请先清理相关记录并结束场次，再尝试删除。");
  if (message === "AGENT_CONFIRMATION_MISMATCH") return new ApiError(400, message, "输入的智能体名称不一致，未执行删除。");
  if (message === "INVALID_RUN_AGENTS") return new ApiError(400, message, "请选择符合分配规则且已经启用的智能体。");
  if (message === "RUN_NOT_FOUND") return new ApiError(404, message, "找不到当前实验的这个入口。");
  if (message === "RUN_ENTRY_DELETED") return new ApiError(409, message, "该链接已删除，无法继续报名，请创建新的入口。");
  if (message === "RUN_NOT_CLOSED") return new ApiError(409, message, "请先停止新报名，再确认实验结束后删除链接。");
  if (message === "RUN_CONFIRMATION_MISMATCH") return new ApiError(400, message, "输入的入口码不一致，未执行删除。");
  if (message === "RUN_BUSY") return new ApiError(409, message, "此入口仍有 AI 回复正在生成，请等待回复完成后再删除链接。");
  if (message === "RUN_AGENT_UNAVAILABLE") return new ApiError(409, message, "此入口使用的智能体已停用或不存在，请先检查配置。");
  return error;
}

export async function GET(request?: Request) {
  try {
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const experimentId = await getAdminExperimentId(request);
    return NextResponse.json({ control: await getAgentControl(experimentId) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const experimentId = await getAdminExperimentId(request);
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_AGENT_CONTROL", input.error.issues[0]?.message ?? "智能体或场次设置无效。");
    if (input.data.action === "test_agent") {
      const connection = await resolveAgentTestConnection({ ...input.data.agent, experimentId: experimentId });
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
      const saved = await saveAgentConfig({ ...input.data.agent, experimentId: experimentId }, admin.id);
      if (input.data.testAfterSave) {
        // Read back the committed credential: never test the submitted draft here.
        const connection = await resolveAgentTestConnection({
          id: saved.id, experimentId: experimentId, baseUrl: saved.baseUrl, botId: saved.botId,
        });
        let test;
        try {
          await testCozeConnection({ ...connection, timeoutMs: 20_000 });
          test = { ok: true, message: "配置已保存，数据库 Token 连接成功。" };
        } catch (error) {
          test = { ok: false, message: "配置已保存，但连接失败：" + formatAgentTestFailure(error, { secret: connection.token }) };
        }
        return NextResponse.json({ control: await getAgentControl(experimentId), test });
      }
    } else if (input.data.action === "activate_run") {
      await activateExperimentRun({ ...input.data.run, experimentId: experimentId }, admin.id);
    } else if (input.data.action === "reopen_run") {
      await reopenExperimentRun(experimentId, input.data.runId, admin.id);
    } else if (input.data.action === "delete_run_link") {
      await deleteExperimentRunLink({ ...input.data,experimentId }, admin.id);
    } else {
      await closeActiveExperimentRun(experimentId, admin.id, input.data.runId);
    }
    return NextResponse.json({ control: await getAgentControl(experimentId) });
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
    const experimentId = await getAdminExperimentId(request);
    const input = deleteSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_AGENT_DELETE", "删除确认信息无效。");
    await deleteAgentConfig({ ...input.data, experimentId: experimentId }, admin.id);
    return NextResponse.json({ control: await getAgentControl(experimentId) });
  } catch (error) { return errorResponse(controlError(error)); }
}
