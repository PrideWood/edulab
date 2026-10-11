/**
 * Convert provider failures into concise administrator-facing messages without
 * exposing credentials that may have appeared in an upstream error.
 * @param {unknown} error
 * @param {{ secret?: string, provider?: "coze" | "dify" }} [options]
 */
export function formatAgentTestFailure(error, options = {}) {
  const provider = options.provider === "dify" ? "Dify" : "Coze";
  const target = provider === "Dify" ? "应用类型及接口配置" : "Bot ID、模型及接口配置";
  const value = error && typeof error === "object" ? error : {};
  const status = typeof value.status === "number"
    ? value.status
    : typeof value.response?.status === "number" ? value.response.status : undefined;
  const rawCode = typeof value.cozeCode === "string" || typeof value.cozeCode === "number"
    ? String(value.cozeCode)
    : typeof value.code === "string" || typeof value.code === "number" ? String(value.code) : "";
  const code = sanitizeMessage(rawCode, options.secret ?? "");
  const name = typeof value.name === "string" ? value.name : "";
  const rawDetail = [value.msg, value.detail, value.message]
    .find((item) => typeof item === "string" && item.trim());
  const detail = sanitizeMessage(rawDetail ?? "", options.secret ?? "");

  if (code === "COZE_TEST_TIMEOUT" || status === 408 || /timeout|abort/i.test(`${name} ${code}`)) {
    return "连接超时，请检查网络、Base URL 或服务状态。";
  }
  if (!status && (/connection|network|enotfound|econnrefused|econnreset|fetch failed/i.test(`${name} ${code} ${detail}`) || name === "APIConnectionError")
    || /enotfound|econnrefused|econnreset|network error|fetch failed/i.test(detail)) {
    return `网络连接失败，请检查 Base URL、网络和 ${provider} 服务状态。`;
  }
  if (status === 401) return "API Key 无效或已过期（401 Unauthorized）。";
  if (status === 403) return "API Key 无效、权限不足，或当前智能体未授权（403 Forbidden）。";
  if (status === 404) return withDetail(provider === "Dify" ? "Base URL 或应用不存在（404 Not Found）" : "Base URL、Bot ID 或模型不存在（404 Not Found）", detail);
  if (status === 429) return "请求过多或额度受限（429 Too Many Requests），请稍后重试或检查额度。";
  if (status === 400) return withDetail(`请求参数无效（400 Bad Request），请检查 ${target}`, detail);
  if (status && status >= 500) return withDetail(`${provider} 服务端错误（HTTP ${status}）`, detail);
  if (detail) return `${provider} 请求失败${code ? `（${code}）` : ""}：${detail}`;
  return provider === "Dify" ? "连接失败，请检查 Base URL、API Key 和应用状态。" : "连接失败，请检查 Base URL、API Key、Bot ID 和服务状态。";
}

function withDetail(summary, detail) {
  return detail ? `${summary}：${detail}` : `${summary}。`;
}

function sanitizeMessage(message, secret) {
  let safe = String(message).replace(/Bearer\s+[^\s,;]+/gi, "Bearer [已隐藏]");
  safe = safe.replace(/\b(?:app|pat|sk)[-_][A-Za-z0-9._-]{8,}\b/gi, "[已隐藏]");
  if (secret) safe = safe.split(secret).join("[已隐藏]");
  return safe.replace(/\s+/g, " ").trim().slice(0, 360);
}
