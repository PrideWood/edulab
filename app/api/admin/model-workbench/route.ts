import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { getSharedModelConnection, getSharedModelSummary, saveSharedModel } from "@/lib/shared-model";
import { DeepSeekError, deepSeekBaseUrl, runDeepSeekChat } from "@/lib/deepseek";

export const runtime = "nodejs";
export const maxDuration = 120;
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save_model"), baseUrl: z.url(), token: z.string().trim().max(2000).optional(),
    config: z.object({ model: z.string().trim().min(1).max(200), temperature: z.number().min(0).max(2),
      maxTokens: z.number().int().min(1).max(65536), thinking: z.boolean() }) }),
  z.object({ action: z.literal("compare"), prompt: z.string().trim().min(1).max(20000),
    variants: z.array(z.object({ name: z.string().trim().min(1).max(100), systemPrompt: z.string().max(30000) })).min(2).max(4) }),
]);
export async function GET() {
  try {
    if (!await getAuthenticatedAdmin()) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    return NextResponse.json({ model: await getSharedModelSummary() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) throw new ApiError(400, "INVALID_WORKBENCH", "请检查模型参数、测试问题和对比提示词（2–4 组）。");
    const input = parsed.data;
    if (input.action === "save_model") {
      const baseUrl = deepSeekBaseUrl(input.baseUrl);
      return NextResponse.json({ model: await saveSharedModel({ ...input, baseUrl }, admin.id) });
    }
    // Resolve one immutable set of model parameters and one key for this comparison.
    const shared = await getSharedModelConnection();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 110_000);
    const cancel = () => abort.abort();
    request.signal.addEventListener("abort", cancel, { once: true });
    if (request.signal.aborted) cancel();
    const encoder = new TextEncoder();
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const emit = (value: object) => {
          if (!closed) try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(value)}\n\n`)); } catch { closed = true; cancel(); }
        };
        const heartbeat = setInterval(() => {
          if (!closed) try { controller.enqueue(encoder.encode(": keep-alive\n\n")); } catch { closed = true; cancel(); }
        }, 10_000);
        void (async () => {
          try {
            emit({ event: "start", model: shared.config, prompt: input.prompt, variants: input.variants });
            await Promise.allSettled(input.variants.map(async (variant, index) => {
              try {
                const reply = await runDeepSeekChat({ token: shared.token, baseUrl: shared.baseUrl,
                  directModel: { ...shared.config, systemPrompt: variant.systemPrompt },
                  messages: [{ role: "user", content: input.prompt }], signal: abort.signal,
                  onAnswer: async answer => { emit({ event: "delta", index, answer }); } });
                emit({ event: "result", index, answer: reply.answer });
              } catch (error) {
                emit({ event: "failure", index, message: error instanceof DeepSeekError ? error.message : abort.signal.aborted ? "测试已停止或超时。" : "此组测试暂时失败，请稍后重试。" });
              }
            }));
            emit({ event: "done" });
          } finally {
            clearTimeout(timeout); clearInterval(heartbeat);
            request.signal.removeEventListener("abort", cancel);
            if (!closed) { closed = true; controller.close(); }
          }
        })();
      }, cancel() { closed = true; cancel(); },
    });
    return new Response(body, { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Accel-Buffering": "no" } });
  } catch (error) {
    return errorResponse(error instanceof DeepSeekError ? new ApiError(error.status, error.code, error.message) : error);
  }
}
