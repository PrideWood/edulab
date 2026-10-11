import type { SessionPayload } from "@/lib/client-types";
import { readSse } from "@/lib/sse";

export async function readChatStream(response: Response, expected: {
  sessionId: string; clientRequestId: string; onAnswer: (answer: string) => void;
}): Promise<SessionPayload> {
  if (!response.body) throw new Error("AI 回复流中断，请稍后核对恢复结果。");
  for await (const frame of readSse(response.body)) {
    const event = JSON.parse(frame);
    if (event.event === "error") throw new Error(event.message ?? "AI 回复流中断。");
    if (event.event === "completed") {
      if (event.payload?.session?.id !== expected.sessionId) throw new Error("回复不属于当前实验对话。");
      return event.payload;
    }
    if (event.sessionId !== expected.sessionId || event.clientRequestId !== expected.clientRequestId) {
      throw new Error("回复不属于当前实验请求。");
    }
    if (event.event === "delta" && typeof event.answer === "string") expected.onAnswer(event.answer);
  }
  throw new Error("AI 回复流中断，正在恢复已保存的结果。");
}
