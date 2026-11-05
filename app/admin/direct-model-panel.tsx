"use client";

import { useRef, useState, type FormEvent } from "react";
import { timeoutSignal } from "@/lib/timeout-signal";
import { DEFAULT_DIRECT_MODEL, type DirectModelConfig } from "@/lib/direct-model-config";

export interface DirectAgent {
  id: string; internalName: string; baseUrl: string; directModel?: DirectModelConfig;
  hasToken: boolean; enabled: boolean; hasReferences: boolean; hasExperimentRecords: boolean; updatedAt: string;
}
interface DirectDraft {
  id?: string; internalName: string; provider: "deepseek"; baseUrl: string; botId: string;
  token?: string; enabled: boolean; directModel: DirectModelConfig;
}
const styles = [
  { name: "耐心引导", prompt: "你是一位耐心的学习导师。使用中文，一次提出一个关键问题，逐步引导学生自行思考和验证。先回应学生已有的思路，给出必要提示，避免直接替学生完成全部任务。", temperature: 0.7 },
  { name: "严谨分析", prompt: "你是一位严谨的分析助手。使用中文，先给出结论，再分点说明依据和推理。区分事实、假设与不确定性，不编造来源。语言客观、准确，避免无关的寒暄。", temperature: 0.3 },
  { name: "创意启发", prompt: "你是一位富有创意的学习伙伴。使用中文，以生动的类比和具体例子启发思考，提出多个可比较的思路。表达轻松友好，同时保证事实准确，并说明想法的适用条件。", temperature: 1.1 },
];

export function DirectModelPanel({ endpoint, agents, activeIds, busy, onSave, onDelete }: {
  endpoint: string; agents: DirectAgent[]; activeIds: Set<string>; busy: boolean;
  onSave: (draft: DirectDraft) => Promise<void>; onDelete: (agent: DirectAgent) => void;
}) {
  const [adding, setAdding] = useState(false);
  return <section className="settings-card direct-model-panel">
    <div className="settings-card-head"><div><h2>DeepSeek 大模型直连</h2><p>直接填写 API Key，设置模型、系统提示词与输出风格。每种风格可保存为独立配置，再在下方创建分组入口。多轮对话需要开启“数据保存”中的数据库消息保存。</p></div><button type="button" className="admin-refresh" disabled={busy || adding} onClick={() => setAdding(true)}>新增直连配置</button></div>
    <p className="direct-model-note">API Key 加密保存且不会回显。开放入口或已有实验记录的配置仅允许更新 Key；需要更换风格时请新增配置。</p>
    {agents.length === 0 && !adding && <p className="directory-empty">尚未配置 DeepSeek，点击“新增直连配置”开始。</p>}
    {agents.map(agent => <details className="direct-model-item" key={`${agent.id}-${agent.updatedAt}`}><summary><strong>{agent.internalName}</strong><span>{agent.directModel?.model} · {activeIds.has(agent.id) || agent.hasExperimentRecords ? "配置已锁定" : agent.enabled ? "已启用" : "已停用"}</span></summary><DirectModelForm endpoint={endpoint} agent={agent} locked={activeIds.has(agent.id) || agent.hasExperimentRecords} busy={busy} onSave={onSave} onDelete={() => onDelete(agent)} /></details>)}
    {adding && <div className="direct-model-item"><h3>新增 DeepSeek 配置</h3><DirectModelForm endpoint={endpoint} locked={false} busy={busy} onSave={onSave} onCancel={() => setAdding(false)} /></div>}
  </section>;
}

function DirectModelForm({ endpoint, agent, locked, busy, onSave, onDelete, onCancel }: {
  endpoint: string; agent?: DirectAgent; locked: boolean; busy: boolean; onSave: (draft: DirectDraft) => Promise<void>;
  onDelete?: () => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(agent?.internalName ?? "");
  const [baseUrl, setBaseUrl] = useState(agent?.baseUrl ?? "https://api.deepseek.com");
  const [token, setToken] = useState("");
  const [config, setConfig] = useState<DirectModelConfig>(agent?.directModel ?? { ...DEFAULT_DIRECT_MODEL });
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [testing, setTesting] = useState(false);
  const testingRef = useRef(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const disabled = locked || busy || testing;
  const canConnect = !!(baseUrl.trim() && config.model.trim() && (token.trim() || agent?.hasToken));
  const draft = (): DirectDraft => ({ ...(agent ? { id: agent.id } : {}), internalName: name, provider: "deepseek", baseUrl,
    botId: "", ...(token.trim() ? { token: token.trim() } : {}), enabled, directModel: config });
  function change<K extends keyof DirectModelConfig>(key: K, value: DirectModelConfig[K]) {
    setConfig(current => ({ ...current, [key]: value })); setResult(null);
  }
  async function test() {
    if (testingRef.current) return;
    testingRef.current = true; setTesting(true); setResult(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "test_agent", agent: draft() }), signal: timeoutSignal(30_000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "连接失败，请检查配置。");
      setResult({ ok: true, message: "连接成功。测试会产生模型调用费用；尚未保存的设置请点击保存。" });
    } catch (error) {
      setResult({ ok: false, message: error instanceof Error ? error.message : "连接失败。" });
    } finally { testingRef.current = false; setTesting(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void onSave(draft()); }
  return <form onSubmit={submit} onChange={() => setResult(null)} className="direct-model-form">
    <div className="form-grid">
      <label><span>配置名称</span><input required maxLength={100} value={name} disabled={disabled} onChange={event => setName(event.target.value)} placeholder="例如：DeepSeek · 引导式风格" /></label>
      <label><span>API Base URL</span><input required type="url" value={baseUrl} disabled={disabled} onChange={event => setBaseUrl(event.target.value)} placeholder="https://api.deepseek.com" /></label>
      <label><span>API Key</span><input type="password" value={token} maxLength={2000} autoComplete="new-password" disabled={busy || testing} onChange={event => setToken(event.target.value)} placeholder={agent?.hasToken ? "已加密保存，留空保留原 Key" : "输入 DeepSeek API Key"} required={!agent?.hasToken} /></label>
      <label><span>模型名称</span><input required list={`deepseek-models-${agent?.id ?? "new"}`} maxLength={200} value={config.model} disabled={disabled} onChange={event => change("model", event.target.value)} /><datalist id={`deepseek-models-${agent?.id ?? "new"}`}><option value="deepseek-flash" /><option value="deepseek-v4-pro" /></datalist></label>
      <div className="wide direct-style-presets"><span>风格预设</span>{styles.map(style => <button key={style.name} type="button" className="admin-refresh" disabled={disabled} onClick={() => { setConfig(current => ({ ...current, systemPrompt: style.prompt, temperature: style.temperature })); setResult(null); }}>{style.name}</button>)}<small>选择预设会替换下方提示词，仍可继续编辑。</small></div>
      <label className="wide"><span>系统提示词</span><textarea value={config.systemPrompt} rows={8} maxLength={30000} disabled={disabled} onChange={event => change("systemPrompt", event.target.value)} placeholder="填写角色定位、回答语气、引导策略、输出格式等规则…" /></label>
      <label><span>温度 Temperature（0–2）</span><input required type="number" min={0} max={2} step={0.1} value={config.temperature} disabled={disabled || config.thinking} onChange={event => change("temperature", event.target.valueAsNumber)} /><small>越低越稳定，越高越多样；思考模式下温度不生效。</small></label>
      <label><span>最大输出 Token 数</span><input required type="number" min={1} max={65536} step={1} value={config.maxTokens} disabled={disabled} onChange={event => change("maxTokens", event.target.valueAsNumber)} /><small>思考模式下包含思考过程消耗的 Token。</small></label>
      <label className="direct-checkbox"><input type="checkbox" checked={config.thinking} disabled={disabled} onChange={event => change("thinking", event.target.checked)} /><span>启用深度思考</span></label>
      <label className="direct-checkbox"><input type="checkbox" checked={enabled} disabled={disabled} onChange={event => setEnabled(event.target.checked)} /><span>允许用于新分组</span></label>
    </div>
    {result && <p className={result.ok ? "agent-success" : "directory-error"} role={result.ok ? "status" : "alert"}>{result.message}</p>}
    <div className="direct-model-actions"><button type="button" className="admin-refresh" disabled={busy || testing || !canConnect} onClick={() => void test()}>{testing ? "测试中…" : "测试连通（消耗额度）"}</button><button type="submit" className="admin-save" disabled={busy || testing || !canConnect || !name.trim() || (locked && !token.trim())}>{busy ? "保存中…" : locked ? "更新 Key" : "保存配置"}</button>{onDelete && <button type="button" className="admin-danger" disabled={busy || testing || locked || agent?.hasReferences} onClick={onDelete}>删除</button>}{onCancel && <button type="button" className="admin-refresh" disabled={busy || testing} onClick={onCancel}>取消</button>}</div>
  </form>;
}
