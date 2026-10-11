import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { AuthenticatedSession } from "@/lib/session";
import { readSse } from "@/lib/sse";

export class DifyChatError extends Error {
  constructor(public code: string, message: string, public status = 502, public definitive = false) {
    super(message);
    this.name = "DifyChatError";
  }
}

export function difyUser(session: AuthenticatedSession) {
  // Do not send names or student numbers. Include immutable IDs rather than the
  // reusable P/T code; distinct conversations also get distinct provider users.
  const scope = JSON.stringify([session.experimentId, session.participantId, session.configSnapshot?.ai.agentId, session.publicId]);
  return `edulab_${createHash("sha256").update(scope).digest("hex")}`;
}

export function difyBaseUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash
    || !(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)))) {
    throw new DifyChatError("INVALID_BASE_URL", "Dify API Base URL 无效，请填写 HTTPS API 地址。", 400, true);
  }
  return url.href.replace(/\/+$/, "");
}

export function safeDifyError(error: unknown, secret = "") {
  const raw = error instanceof Error ? error.message : "Dify 请求未能完成，请稍后核对恢复结果。";
  let safe = secret ? raw.split(secret).join("[已隐藏]") : raw;
  safe = safe.replace(/Bearer\s+[^\s,;]+/gi, "Bearer [已隐藏]").replace(/\b(?:app|sk|pat)[-_][A-Za-z0-9._-]{8,}\b/gi, "[已隐藏]");
  return safe.replace(/\s+/g, " ").slice(0, 500);
}

async function checkedFetch(url: string, token: string, init: RequestInit) {
  if (!token) throw new DifyChatError("DIFY_KEY_NOT_CONFIGURED", "尚未配置 Dify API Key。", 400, true);
  const response = await fetch(url, {
    ...init, cache: "no-store", redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...init.headers },
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new DifyChatError(safeDifyError(new Error(String(detail?.code ?? `HTTP_${response.status}`)), token),
      safeDifyError(new Error(String(detail?.message ?? `Dify HTTP ${response.status}`)), token),
      response.status, response.status >= 400 && response.status < 500 && response.status !== 408);
  }
  return response;
}

export interface DifyReply {
  conversationId: string | null;
  messageId: string | null;
  taskId: string | null;
  answer: string;
  replyStartedAt: string | null;
  completedAt: string | null;
}

export async function runDifyChat(input: {
  token: string; baseUrl: string; user: string; conversationId: string | null;
  content: string; signal: AbortSignal;
  onProgress?: (reply: DifyReply) => Promise<void>;
}): Promise<DifyReply> {
  const response = await checkedFetch(`${difyBaseUrl(input.baseUrl)}/chat-messages`, input.token, {
    method: "POST", signal: input.signal,
    body: JSON.stringify({ inputs: {}, query: input.content, response_mode: "streaming",
      conversation_id: input.conversationId ?? "", user: input.user, auto_generate_name: false }),
  });
  if (!response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
    throw new DifyChatError("INVALID_STREAM", "Dify 未返回 SSE 流式响应。请确认应用类型和 API 地址。", 502, true);
  }
  const reply: DifyReply = { conversationId: input.conversationId, messageId: null, taskId: null, answer: "", replyStartedAt: null, completedAt: null };
  let agentChunks = false;
  for await (const frame of readSse(response.body)) {
    let event;
    try { event = JSON.parse(frame) as Record<string, unknown>; }
    catch { throw new DifyChatError("INVALID_EVENT", "Dify 返回了无效的流式事件。"); }
    if (!event || typeof event !== "object") throw new DifyChatError("INVALID_EVENT", "Dify 返回了无效的流式事件。");
    for (const [key, property] of [["conversation_id", "conversationId"], ["message_id", "messageId"], ["task_id", "taskId"]] as const) {
      const value = event[key];
      if (value === undefined) continue;
      if (typeof value !== "string" || !value || value.length > 200 || value.includes(input.token)) throw new DifyChatError("INVALID_IDS", "Dify 返回了无效的会话标识。");
      if (reply[property] && reply[property] !== value) throw new DifyChatError("CONVERSATION_MISMATCH", "Dify 回复的会话标识不匹配，已停止处理。");
      reply[property] = value;
    }
    if (event.event === "error") {
      throw new DifyChatError(safeDifyError(new Error(String(event.code ?? "STREAM_ERROR")), input.token),
        safeDifyError(new Error(String(event.message ?? "Dify 流式请求失败")), input.token), Number(event.status) || 502, true);
    }
    const data = event.data as { status?: string; error?: string } | undefined;
    if (event.event === "workflow_finished" && data?.status === "failed") {
      throw new DifyChatError("WORKFLOW_FAILED", safeDifyError(new Error(data.error ?? "Dify 工作流执行失败"), input.token), 502, true);
    }
    if (event.event === "human_input_required") throw new DifyChatError("UNSUPPORTED_INPUT", "当前 Dify 应用需要人工审批，请使用直接返回聊天回复的应用。", 400, true);
    if (["message", "agent_message", "message_replace"].includes(String(event.event)) && typeof event.answer === "string") {
      // Agent apps repeat the entire final answer in a closing message event.
      if (event.event === "agent_message") agentChunks = true;
      reply.answer = event.event === "message_replace" || (agentChunks && event.event === "message")
        ? event.answer : reply.answer + event.answer;
      reply.replyStartedAt ??= new Date().toISOString();
      if (reply.answer.length > 100_000) throw new DifyChatError("ANSWER_TOO_LONG", "Dify 回复超过记录长度限制。", 502, true);
    }
    if (event.event === "message_end") {
      if (!reply.messageId || !reply.conversationId || !reply.answer.trim()) throw new DifyChatError("NO_ANSWER", "Dify 未返回完整回复和会话标识。", 502, true);
      reply.completedAt = new Date().toISOString();
    }
    await input.onProgress?.({ ...reply });
    if (reply.completedAt) return reply;
  }
  throw new DifyChatError("STREAM_INTERRUPTED", "Dify 回复流中断，正在核对会话中已保存的结果。");
}

export async function findDifyMessage(input: { token: string; baseUrl: string; user: string; conversationId: string; messageId: string }) {
  const url = new URL(`${difyBaseUrl(input.baseUrl)}/messages`);
  url.searchParams.set("conversation_id", input.conversationId);
  url.searchParams.set("user", input.user); url.searchParams.set("limit", "100");
  const response = await checkedFetch(url.href, input.token, { signal: AbortSignal.timeout(15_000) });
  const result = await response.json() as { data?: Array<{ id: string; conversation_id: string; answer: string; query: string; created_at: number; status?: string; error?: string | null }> };
  if (!Array.isArray(result.data)) throw new DifyChatError("INVALID_HISTORY", "Dify 返回了无效的会话记录。");
  return result.data.find(message => message.id === input.messageId && message.conversation_id === input.conversationId) ?? null;
}

export async function testDifyConnection(input: { token: string; baseUrl: string; timeoutMs?: number }) {
  const signal = AbortSignal.timeout(input.timeoutMs ?? 20_000);
  try {
    await runDifyChat({ ...input, user: `edulab_admin_test_${randomUUID()}`, conversationId: null,
      content: "Reply with OK.", signal });
  } catch (error) {
    if (signal.aborted) throw new DifyChatError("DIFY_TEST_TIMEOUT", "Dify 连通测试超时。", 504, true);
    throw error;
  }
}
