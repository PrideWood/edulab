import { timeoutSignal } from "@/lib/timeout-signal";

export class ClientApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export async function readApiJson<T>(response: Response): Promise<T> {
  const data: unknown = await response.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new ClientApiError(response.ok ? 502 : response.status, "INVALID_RESPONSE",
      "服务暂时繁忙或连接中断，请稍后重试；已填写的信息仍保留。");
  }
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } }).error;
    throw new ClientApiError(response.status, error?.code ?? "REQUEST_FAILED", error?.message ?? "服务暂时繁忙，请稍后重试。");
  }
  return data as T;
}

// Registration alone can be safely replayed with the SAME persistent request
// ID. Do not use this retry loop for arbitrary mutations or AI requests.
export async function registerParticipant<T>(url: string, body: string, onRetry: () => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await readApiJson<T>(await fetch(url, {
        method: "POST", headers: { "Content-Type": "application/json" }, body,
        signal: timeoutSignal(45_000),
      }));
    } catch (error) {
      const transient = error instanceof ClientApiError
        ? error.status === 408 || error.status === 429 || error.status >= 500
        : error instanceof Error && ["TypeError", "AbortError", "TimeoutError"].includes(error.name);
      if (!transient || attempt >= 2) throw error;
      onRetry();
      await new Promise(resolve => setTimeout(resolve, 1500 * 2 ** attempt + Math.random() * 1500));
    }
  }
}
