"use client";

import { useEffect, useState, type FormEvent } from "react";
import { DEFAULT_DIRECT_MODEL, type DirectModelConfig } from "@/lib/direct-model-config";
import type { SharedModelSummary } from "@/lib/shared-model";
import { ModelComparison } from "./model-comparison";

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

export function DirectModelPanel({ agents, activeIds, busy, onSave, onDelete }: {
  endpoint: string; agents: DirectAgent[]; activeIds: Set<string>; busy: boolean;
  onSave: (draft: DirectDraft) => Promise<unknown>; onDelete: (agent: DirectAgent) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [model, setModel] = useState<SharedModelSummary | null>(null);
  const [error, setError] = useState("");
  const [copy, setCopy] = useState<DirectAgent | undefined>();
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/model-workbench", { cache: "no-store", signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "模型配置读取失败。");
      setModel(data.model);
    }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "模型配置读取失败。"); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  const presets = styles.map(style => ({ name: style.name, systemPrompt: style.prompt }));
  return <section className="settings-card direct-model-panel">
    <div className="settings-card-head"><div><h2>DeepSeek 提示词工作台</h2><p>共享模型与 API Key 只需配置一次，所有实验可复用。通过不同系统提示词创建风格，并使用统一问题对比输出。</p></div><button type="button" className="admin-refresh" disabled={busy || adding || !model?.hasToken} onClick={() => { setCopy(undefined); setAdding(true); }}>新增提示词风格</button></div>
    {error && <p className="directory-error" role="alert">{error}</p>}
    {loading && <p role="status">读取共享模型配置…</p>}
    {model && <SharedModelSettings key={model.updatedAt ?? "new"} model={model} onSaved={setModel} />}
    <ModelComparison agents={agents} presets={presets} configured={!!model?.hasToken} />
    <div className="settings-card-head"><div><h3>实验提示词风格</h3><p>风格用于创建下方实验分组。开放入口或已有实验记录的提示词保持锁定；可复制为新风格。多轮对话需要开启数据库消息保存。</p></div></div>
    {agents.length === 0 && !adding && <p className="directory-empty">保存共享模型后，新增提示词风格即可，无需重复填写 API Key。</p>}
    {agents.map(agent => <details className="direct-model-item" key={`${agent.id}-${agent.updatedAt}`}><summary><strong>{agent.internalName}</strong><span>{agent.directModel?.useSharedConnection ? "共享模型" : "旧版独立配置"} · {activeIds.has(agent.id) || agent.hasExperimentRecords ? "提示词已锁定" : agent.enabled ? "已启用" : "已停用"}</span></summary>
      <StyleForm agent={agent} model={model} locked={activeIds.has(agent.id) || agent.hasExperimentRecords} busy={busy} onSave={onSave} onDelete={() => onDelete(agent)} />
      {!agent.directModel?.useSharedConnection && <LegacyKeySettings agent={agent} busy={busy} onSave={onSave} />}
      <button type="button" className="admin-refresh" disabled={busy || adding || !model?.hasToken} onClick={() => { setCopy(agent); setAdding(true); }}>复制为新风格</button>
    </details>)}
    {adding && <div className="direct-model-item"><h3>新增提示词风格</h3><StyleForm key={copy?.id ?? "new"} source={copy} model={model} locked={false} busy={busy} onSave={async draft => { const result = await onSave(draft); if (result === true) setAdding(false); return result; }} onCancel={() => setAdding(false)} /></div>}
  </section>;
}

export function SharedModelSettings({ model, onSaved }: { model: SharedModelSummary; onSaved: (model: SharedModelSummary) => void }) {
  const [baseUrl, setBaseUrl] = useState(model.baseUrl);
  const [token, setToken] = useState("");
  const [config, setConfig] = useState(model.config);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); if (saving) return;
    setSaving(true); setError("");
    try {
      const response = await fetch("/api/admin/model-workbench", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "save_model", baseUrl, token, config }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error?.message ?? "模型配置保存失败。");
      setToken(""); onSaved(data.model);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存失败。"); }
    finally { setSaving(false); }
  }
  return <details className="shared-model-settings">
    <summary><strong>共享模型设置</strong><span>{model.hasToken ? `${model.config.model} · Key 已加密保存 · 点击修改` : "尚未配置 · 点击填写 API Key"}</span></summary>
    <form onSubmit={save} className="direct-model-form">
      <p className="direct-model-note">此配置跨实验共享。Key 留空保留原值；更换模型和参数影响新加入的共享风格会话及后续测试，已有会话仍使用原模型快照。更新 Key 会用于所有共享风格会话。</p>
      <fieldset disabled={saving} className="shared-model-fields form-grid">
        <label><span>API Key</span><input type="password" autoComplete="new-password" maxLength={2000} required={!model.hasToken} value={token} onChange={event => setToken(event.target.value)} placeholder={model.hasToken ? "留空保留已保存 Key" : "输入一次 DeepSeek API Key"} /></label>
        <label><span>模型名称</span><input required list="shared-deepseek-models" maxLength={200} value={config.model} onChange={event => setConfig({ ...config, model: event.target.value })} /><datalist id="shared-deepseek-models"><option value="deepseek-flash" /><option value="deepseek-v4-pro" /></datalist></label>
        <label className="wide"><span>API Base URL</span><input required type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} /></label>
      </fieldset>
      <details className="model-advanced"><summary>高级输出参数（所有对比组保持一致）</summary><div className="form-grid">
        <label><span>温度（0–2）</span><input type="number" required min={0} max={2} step={0.1} disabled={saving || config.thinking} value={config.temperature} onChange={event => setConfig({ ...config, temperature: event.target.valueAsNumber })} /><small>思考模式下温度不生效。</small></label>
        <label><span>最大输出 Token 数</span><input type="number" required min={1} max={65536} step={1} disabled={saving} value={config.maxTokens} onChange={event => setConfig({ ...config, maxTokens: event.target.valueAsNumber })} /><small>思考模式下包含思考消耗。</small></label>
        <label className="direct-checkbox"><input type="checkbox" disabled={saving} checked={config.thinking} onChange={event => setConfig({ ...config, thinking: event.target.checked })} /><span>深度思考</span></label>
      </div></details>
      {error && <p className="directory-error" role="alert">{error}</p>}
      <button className="admin-save" type="submit" disabled={saving}>{saving ? "保存中…" : "保存共享模型"}</button>
    </form>
  </details>;
}

function StyleForm({ agent, source, model, locked, busy, onSave, onDelete, onCancel }: {
  agent?: DirectAgent; source?: DirectAgent; model: SharedModelSummary | null; locked: boolean; busy: boolean;
  onSave: (draft: DirectDraft) => Promise<unknown>; onDelete?: () => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(agent?.internalName ?? (source ? `${source.internalName} 副本` : ""));
  const [prompt, setPrompt] = useState((agent ?? source)?.directModel?.systemPrompt ?? DEFAULT_DIRECT_MODEL.systemPrompt);
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  function submit(event: FormEvent) {
    event.preventDefault(); if (!model?.hasToken || locked || busy) return;
    void onSave({ ...(agent ? { id: agent.id } : {}), internalName: name, provider: "deepseek", baseUrl: model.baseUrl, botId: "", enabled,
      directModel: { ...model.config, systemPrompt: prompt, useSharedConnection: true } });
  }
  return <form className="direct-model-form" onSubmit={submit}>
    {agent && !agent.directModel?.useSharedConnection && <p className="direct-model-note">此风格保留旧版独立配置。未锁定时保存将改用共享模型；已锁定时可复制提示词创建共享风格，原会话继续使用原配置。</p>}
    <div className="form-grid"><label className="wide"><span>风格名称</span><input required maxLength={100} disabled={locked || busy} value={name} onChange={event => setName(event.target.value)} placeholder="例如：引导式教学" /></label>
      <div className="wide direct-style-presets"><span>提示词预设</span>{styles.map(style => <button type="button" className="admin-refresh" key={style.name} disabled={locked || busy} onClick={() => setPrompt(style.prompt)}>{style.name}</button>)}</div>
      <label className="wide"><span>系统提示词</span><textarea rows={7} maxLength={30000} value={prompt} disabled={locked || busy} onChange={event => setPrompt(event.target.value)} /></label>
      <details className="model-advanced wide"><summary>风格选项</summary><label className="direct-checkbox"><input type="checkbox" checked={enabled} disabled={locked || busy} onChange={event => setEnabled(event.target.checked)} /><span>允许用于新分组</span></label></details>
    </div>
    <div className="direct-model-actions"><button type="submit" className="admin-save" disabled={busy || locked || !model?.hasToken || !name.trim()}>保存提示词风格</button>{onDelete && <button type="button" className="admin-danger" disabled={busy || locked || agent?.hasReferences} onClick={onDelete}>删除</button>}{onCancel && <button type="button" className="admin-refresh" disabled={busy} onClick={onCancel}>取消</button>}</div>
  </form>;
}

function LegacyKeySettings({ agent, busy, onSave }: { agent: DirectAgent; busy: boolean; onSave: (draft: DirectDraft) => Promise<unknown> }) {
  const [token, setToken] = useState("");
  return <details className="model-advanced"><summary>旧版连接与 Key 维护</summary>
    <p className="direct-model-note">原模型：{agent.directModel?.model} · {agent.baseUrl}。此处仅用于维护已有独立会话；新风格请使用上方共享模型。</p>
    <form className="direct-model-form" onSubmit={event => {
      event.preventDefault();
      if (busy || !token.trim() || !agent.directModel) return;
      void onSave({ id: agent.id, internalName: agent.internalName, provider: "deepseek", baseUrl: agent.baseUrl, botId: "",
        enabled: agent.enabled, directModel: agent.directModel, token: token.trim() }).then(result => { if (result === true) setToken(""); });
    }}><div className="form-grid"><label className="wide"><span>更换旧版会话 API Key</span><input type="password" required maxLength={2000} disabled={busy} autoComplete="new-password" value={token} onChange={event => setToken(event.target.value)} placeholder="输入新 Key，保存后不回显" /></label></div>
      <button type="submit" className="admin-refresh" disabled={busy || !token.trim()}>更新旧版 Key</button>
    </form>
  </details>;
}
