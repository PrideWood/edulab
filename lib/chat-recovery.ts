import type { SessionPayload } from "@/lib/client-types";
import { ClientApiError } from "@/lib/client-api";

// Only read the original request's outcome here. Never create another AI turn.
export async function recoverChatResponse(options: {
  sessionId: string;
  clientRequestId: string;
  read: () => Promise<SessionPayload>;
  onPayload: (payload: SessionPayload) => void;
  isCurrent: () => boolean;
}) {
  let latest: SessionPayload | null = null;
  let absent = 0;
  const deadline = Date.now() + 5 * 60_000;
  for (let attempt = 0; attempt < 40 && Date.now() < deadline; attempt++) {
    if (!options.isCurrent()) return { state: "cancelled" as const, payload: latest };
    try {
      const payload = await options.read();
      if (!options.isCurrent()) return { state: "cancelled" as const, payload: latest };
      if (payload.session.id !== options.sessionId) {
        throw new ClientApiError(401, "SESSION_REPLACED", "当前会话已改变，请使用最近恢复的窗口继续实验。");
      }
      latest = payload;
      options.onPayload(payload);
      const user = payload.messages.find(message => message.clientRequestId === options.clientRequestId);
      if (user && payload.messages.some(message => message.role === "assistant" && message.turnIndex === user.turnIndex)) {
        return { state: "completed" as const, payload };
      }
      if (payload.failedRequest?.clientRequestId === options.clientRequestId) {
        return { state: "failed" as const, payload };
      }
      // A queued POST may not have committed yet. Require several successful
      // reads before offering an idempotent retry of the original request ID.
      if (!payload.pending && !user) {
        if (++absent >= 4) return { state: "unconfirmed" as const, payload };
      } else absent = 0;
    } catch (error) {
      if (error instanceof ClientApiError && error.status < 500 && ![408, 429].includes(error.status)) throw error;
      if (!(error instanceof ClientApiError) && !(error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name))) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(5000, 1500 + attempt * 250) + Math.random() * 1000));
  }
  return { state: "unconfirmed" as const, payload: latest };
}
