import "server-only";

import type { DirectModelConfig } from "@/lib/direct-model-config";
import { readSse } from "@/lib/sse";

export class DeepSeekError extends Error {
  constructor(public code: string, message: string, public status = 502, public definitive = false) {
    super(message);
    this.name = "DeepSeekError";
  }
}

export type ModelContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };
export type ModelMessage = { role: "system" | "user" | "assistant"; content: string | ModelContentPart[] };
export type ModelReply = { answer: string; messageId: string; replyStartedAt: string | null; completedAt: string };

export function deepSeekBaseUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
    !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new DeepSeekError("INVALID_BASE_URL", "请填写有效的 HTTPS API Base URL。", 400, true);
  }
  return url.href.replace(/\/+$/, "");
}

export async function runDeepSeekChat(input: {
  token: string; baseUrl: string; directModel?: DirectModelConfig; messages: ModelMessage[];
  signal: AbortSignal; jsonOutput?: boolean; onAnswer?: (answer: string) => Promise<void>;
}): Promise<ModelReply> {
  if (!input.token || !input.directModel?.model) throw new DeepSeekError("MODEL_NOT_CONFIGURED", "请先配置 DeepSeek API Key 和模型。", 400, true);
  const config = input.directModel;
  const response = await fetch(`${deepSeekBaseUrl(input.baseUrl)}/chat/completions`, {
    method: "POST", cache: "no-store", redirect: "error", signal: input.signal,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${input.token}` },
    body: JSON.stringify({ model: config.model,
      messages: [...(config.systemPrompt ? [{ role: "system", content: config.systemPrompt }] : []), ...input.messages],
      stream: true, ...(input.jsonOutput ? { response_format: { type: "json_object" } } : {}), temperature: config.temperature, max_tokens: config.maxTokens,
      thinking: { type: config.thinking ? "enabled" : "disabled" },
    }),
  });
  if (!response.ok) {
    // Never return upstream bodies: they may contain credentials or private prompts.
    throw new DeepSeekError(`DEEPSEEK_HTTP_${response.status}`, `DeepSeek 请求失败（HTTP ${response.status}），请检查 API Key、模型、参数与额度。`,
      response.status, response.status >= 400 && response.status < 500 && response.status !== 408);
  }
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new DeepSeekError("INVALID_STREAM", "DeepSeek 未返回有效的流式响应。");
  }
  let answer = "", messageId = "", replyStartedAt: string | null = null, finished = false;
  for await (const frame of readSse(response.body)) {
    if (frame === "[DONE]") break;
    let event;
    try { event = JSON.parse(frame); } catch { throw new DeepSeekError("INVALID_EVENT", "模型回复格式无效。"); }
    if (event.error) throw new DeepSeekError("DEEPSEEK_STREAM_ERROR", "DeepSeek 返回错误，请检查服务状态与额度。", 502, true);
    if (typeof event.id === "string" && event.id.length <= 200 && !event.id.includes(input.token)) messageId ||= event.id;
    const choice = event.choices?.[0];
    // reasoning_content is deliberately excluded from the student-facing answer.
    if (typeof choice?.delta?.content === "string") {
      answer += choice.delta.content;
      replyStartedAt ??= new Date().toISOString();
      if (answer.length > 100_000) throw new DeepSeekError("ANSWER_TOO_LONG", "模型回复超过记录长度限制。", 502, true);
      await input.onAnswer?.(answer);
    }
    if (choice?.finish_reason) {
      if (choice.finish_reason !== "stop") throw new DeepSeekError("INCOMPLETE_ANSWER", choice.finish_reason === "length"
        ? "回复达到 Token 上限，请联系教师增加最大输出 Token 数。" : "模型未能正常完成回复。", 502, true);
      finished = true;
    }
  }
  if (!finished) throw new DeepSeekError("STREAM_INTERRUPTED", "模型回复中断，请核对请求结果。");
  if (!answer.trim()) throw new DeepSeekError("EMPTY_ANSWER", "模型已结束生成，但返回了空内容。", 502, true);
  return { answer, messageId, replyStartedAt, completedAt: new Date().toISOString() };
}

export async function testDeepSeekConnection(input: { token: string; baseUrl: string; directModel?: DirectModelConfig; timeoutMs?: number }) {
  const signal = AbortSignal.timeout(input.timeoutMs ?? 20_000);
  try {
    await runDeepSeekChat({ ...input, messages: [{ role: "user", content: "请简短回复 OK。" }], signal });
  } catch (error) {
    if (signal.aborted) throw new DeepSeekError("DEEPSEEK_TEST_TIMEOUT", "DeepSeek 连通测试超时。", 504, true);
    throw error;
  }
}
