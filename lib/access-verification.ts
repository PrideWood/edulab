import { timeoutSignal } from "@/lib/timeout-signal";
import { ClientApiError, readApiJson } from "@/lib/client-api";

async function readVerification(response: Response) {
  let result: {verified?:unknown};
  try { result = await readApiJson<{verified?:unknown}>(response); }
  catch (error) {
    if (error instanceof ClientApiError && error.code === "INVALID_RESPONSE") {
      throw new ClientApiError(error.status,error.code,
        "访问验证服务暂时未返回有效结果，请稍后重试；访问码仍保留在输入框中。若持续出现，请刷新教师提供的原实验链接或联系教师。");
    }
    throw error;
  }
  if (result.verified !== true) throw new ClientApiError(502,"UNCONFIRMED_VERIFICATION",
    "尚未确认访问码验证成功，请稍后重试。");
}

// Verification is idempotent and creates no participant or experiment record.
// Retry only transient failures, never an incorrect code or a policy rejection.
export async function verifyAccessCode(accessCode: string, onRetry: (attempt: number) => void) {
  const body = JSON.stringify({accessCode});
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch("/api/access/verify",{
        method:"POST",headers:{"Content-Type":"application/json",Accept:"application/json"},
        credentials:"same-origin",cache:"no-store",redirect:"error",body,signal:timeoutSignal(20_000),
      });
      await readVerification(response);
      return;
    } catch (error) {
      const transient = error instanceof ClientApiError
        ? error.code !== "ACCESS_CODE_NOT_CONFIGURED" && (error.status >= 500 || [408,429].includes(error.status))
        : error instanceof Error && ["TypeError","AbortError","TimeoutError"].includes(error.name);
      if (!transient || attempt >= 2) {
        if (error instanceof ClientApiError) throw error;
        throw new Error("访问验证连接中断或超时，请稍后重试；输入的访问码仍保留。如持续失败，请刷新教师提供的原实验链接或联系教师。");
      }
      onRetry(attempt+2);
      await new Promise(resolve=>setTimeout(resolve,1000*2**attempt+Math.random()*500));
    }
  }
}
