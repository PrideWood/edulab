"use client";

import { useEffect, useRef, useState } from "react";
import { readSse } from "@/lib/sse";
import type { DirectAgent } from "./direct-model-panel";
import type { SharedModelConfig } from "@/lib/shared-model";

interface Variant { name: string; systemPrompt: string }
interface Result { answer: string; state: "pending" | "streaming" | "completed" | "error"; error?: string }
export function ModelComparison({ agents, presets, configured }: { agents: DirectAgent[]; presets: Variant[]; configured: boolean }) {
  const initial = agents.length >= 2 ? agents.slice(0, 2).map(agent => ({ name: agent.internalName, systemPrompt: agent.directModel?.systemPrompt ?? "" })) : presets.slice(0, 2);
  const [variants, setVariants] = useState<Variant[]>(initial);
  const [prompt, setPrompt] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<{ model: SharedModelConfig; prompt: string; variants: Variant[] } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  function update(index: number, patch: Partial<Variant>) { setVariants(current => current.map((item, i) => i === index ? { ...item, ...patch } : item)); }
  async function compare() {
    if (abortRef.current) return;
    const controller = new AbortController(); abortRef.current = controller;
    setRunning(true); setError(""); setSnapshot(null);
    setResults(variants.map(() => ({ answer: "", state: "pending" })));
    let done = false;
    try {
      const response = await fetch("/api/admin/model-workbench", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "compare", prompt, variants }), signal: controller.signal });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error?.message ?? "对比测试失败。"); }
      if (!response.body) throw new Error("测试响应为空。");
      for await (const frame of readSse(response.body)) {
        const event = JSON.parse(frame);
        if (event.event === "start") setSnapshot({ model: event.model, prompt: event.prompt, variants: event.variants });
        if (["delta", "result", "failure"].includes(event.event)) {
          setResults(current => current.map((result, index) => index !== event.index ? result : {
            answer: typeof event.answer === "string" ? event.answer : result.answer,
            state: event.event === "failure" ? "error" : event.event === "result" ? "completed" : "streaming",
            ...(event.message ? { error: event.message } : {}),
          }));
        }
        if (event.event === "done") done = true;
      }
      if (!done) throw new Error("对比连接中断，未完成的结果仅供核对。");
    } catch (failure) {
      const message = controller.signal.aborted ? "已停止测试，未完成的回答仅供核对。" : failure instanceof Error ? failure.message : "测试中断。";
      setError(message);
      setResults(current => current.map(result => ["pending", "streaming"].includes(result.state) ? { ...result, state: "error", error: message } : result));
    } finally { abortRef.current = null; setRunning(false); }
  }
  return <section className="model-comparison">
    <div className="settings-card-head"><div><h3>同一问题，对比不同系统提示词</h3><p>各组使用同一份已保存的共享模型和参数，各发起一次独立请求。每次最多 4 组，消耗对应调用额度；测试中的提示词可自由编辑，不会修改实验配置。</p></div></div>
    <div className="comparison-variants">{variants.map((variant, index) => <div className="comparison-variant" key={index}>
      <label><span>对比 {index + 1} · 载入提示词</span><select disabled={running} value="" onChange={event => {
        const [source, position] = event.target.value.split(":");
        const picked = source === "agent" ? { name: agents[Number(position)].internalName, systemPrompt: agents[Number(position)].directModel?.systemPrompt ?? "" } : presets[Number(position)];
        if (picked) update(index, picked);
      }}><option value="">选择已有风格或预设…</option>{agents.map((agent, i) => <option key={agent.id} value={`agent:${i}`}>{agent.internalName}</option>)}{presets.map((preset, i) => <option key={preset.name} value={`preset:${i}`}>预设 · {preset.name}</option>)}</select></label>
      <label><span>对比名称</span><input maxLength={100} value={variant.name} disabled={running} onChange={event => update(index, { name: event.target.value })} /></label>
      <label><span>系统提示词（仅本次测试）</span><textarea rows={5} maxLength={30000} value={variant.systemPrompt} disabled={running} onChange={event => update(index, { systemPrompt: event.target.value })} /></label>
      {variants.length > 2 && <button className="admin-refresh" type="button" disabled={running} onClick={() => setVariants(current => current.filter((_, i) => i !== index))}>移除此组</button>}
    </div>)}</div>
    <button className="admin-refresh" type="button" disabled={running || variants.length >= 4} onClick={() => setVariants(current => [...current, { name: `风格 ${current.length + 1}`, systemPrompt: "" }])}>增加对比组</button>
    <label className="comparison-question"><span>统一测试问题 Prompt</span><textarea rows={3} maxLength={20000} disabled={running} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="输入一次问题，例如：我总是记不住英语单词，应该怎么办？" /></label>
    <div className="direct-model-actions"><button type="button" className="admin-save" disabled={running || !configured || !prompt.trim() || variants.some(variant => !variant.name.trim())} onClick={() => void compare()}>{running ? "对比中…" : `开始对比（${variants.length} 组）`}</button>{running && <button type="button" className="admin-refresh" onClick={() => abortRef.current?.abort()}>停止测试</button>}{!configured && <small>请先保存共享模型配置。</small>}</div>
    {error && <p className="directory-error" role="alert">{error}</p>}
    {snapshot && <p className="direct-model-note">本次测试：{snapshot.model.model} · 温度 {snapshot.model.temperature} · 最大输出 {snapshot.model.maxTokens} Token · {snapshot.model.thinking ? "深度思考" : "普通模式"}<br />问题：{snapshot.prompt}</p>}
    <div className="comparison-results" aria-live="polite">{results.map((result, index) => <article className="comparison-result" key={index}><h4>{snapshot?.variants[index]?.name ?? variants[index]?.name}</h4><span className="agent-row-status">{({ pending: "等待回复", streaming: "生成中", completed: "已完成", error: "未完成" })[result.state]}</span><details className="model-advanced"><summary>本次系统提示词</summary><div className="comparison-answer">{snapshot?.variants[index]?.systemPrompt || "（未设置）"}</div></details><div className="comparison-answer">{result.answer || (result.state === "pending" ? "等待模型回复…" : "尚无回答")}</div>{result.error && <p className="directory-error">{result.error}</p>}</article>)}</div>
  </section>;
}
