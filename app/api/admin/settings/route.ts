import { NextResponse } from "next/server";
import { z } from "zod";
import { experiment } from "@/config/experiment";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { getExperimentSettings, saveExperimentSettings } from "@/lib/experiment-settings";
import { ApiError, errorResponse } from "@/lib/http";

const optionalLimit = z.number().int().positive().nullable();
const inputSchema = z.object({
  experiment: z.object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{2,80}$/),
    label: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    introduction: z.string().trim().max(3000),
    requirements: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
    material: z.string().max(20_000),
    hint: z.string().max(5000),
    assistantName: z.string().trim().min(1).max(80),
    welcome: z.string().trim().max(3000),
    taskVisible: z.boolean(),
    chatEnabled: z.boolean(),
  }).refine((value) => value.taskVisible || value.chatEnabled, { message: "任务区域和聊天区域不能同时关闭" }),
  limits: z.object({
    maxUserMessages: optionalLimit.refine((value) => value === null || value <= 1000),
    maxMessageChars: z.number().int().min(1).max(20_000),
    sessionDurationMinutes: optionalLimit.refine((value) => value === null || value <= 7 * 24 * 60),
  }),
  storage: z.object({ databaseMessagesEnabled: z.boolean() }),
  ai: z.object({
    baseUrl: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname));
    }, "API 地址必须使用 HTTPS"),
    botId: z.string().trim().max(200),
    token: z.string().trim().max(2000).optional(),
  }),
});

export async function GET() {
  try {
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    return NextResponse.json({ admin, settings: await getExperimentSettings(experiment.id, false) });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_SETTINGS", input.error.issues[0]?.message ?? "设置内容无效。");
    if (input.data.experiment.id !== experiment.id) throw new ApiError(400, "EXPERIMENT_MISMATCH", "当前版本只能设置已配置的实验。");
    const settings = await saveExperimentSettings(input.data, admin.id);
    return NextResponse.json({ admin, settings });
  } catch (error) { return errorResponse(error); }
}
