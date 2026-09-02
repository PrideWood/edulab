"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { ExperimentSettings } from "@/lib/experiment-settings";

type Section = "participants" | "content" | "limits" | "storage" | "ai";
type Admin = { id: string; username: string; displayName: string };
type ParticipantDirectoryRow = {
  id: string; participantCode: string; fullName: string; studentNumber: string;
  profileUpdatedAt: string | null; sessionCount: number; turnCount: number;
  createdAt: string; lastActivityAt: string | null;
};
type AgentSummary = {
  id: string; internalName: string; baseUrl: string; botId: string;
  hasToken: boolean; enabled: boolean; hasReferences: boolean; updatedAt: string;
};
type RunSummary = {
  id: string; name: string; status: "draft" | "active" | "closed";
  assignmentMode: "fixed" | "balanced_random"; fixedAgentId: string | null;
  randomAgentIds: string[]; openedAt: string | null; closedAt: string | null; createdAt: string;
};
type AgentControl = { agents: AgentSummary[]; runs: RunSummary[]; activeRun: RunSummary | null };

const sections: Array<{ id: Section; number: string; label: string; description: string }> = [
  { id: "participants", number: "01", label: "参与者", description: "身份与编号对应表" },
  { id: "limits", number: "02", label: "交互规则", description: "次数、字数与时长" },
  { id: "ai", number: "03", label: "智能体与场次", description: "Coze 配置和课程切换" },
  { id: "storage", number: "04", label: "数据保存", description: "数据库与人工备份" },
  { id: "content", number: "05", label: "可选任务说明", description: "通常无需展示" },
];

async function parseResponse(response: Response) {
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data?.error?.message ?? "请求失败。"), { status: response.status });
  return data as { admin: Admin; settings: ExperimentSettings };
}

export function AdminWorkspace() {
  const [section, setSection] = useState<Section>("participants");
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [settings, setSettings] = useState<ExperimentSettings | null>(null);
  const [mode, setMode] = useState<"loading" | "login" | "ready">("loading");
  const [status, setStatus] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [saving, setSaving] = useState(false);
  const [participants, setParticipants] = useState<ParticipantDirectoryRow[]>([]);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantsError, setParticipantsError] = useState("");

  const loadParticipants = useCallback(async () => {
    setParticipantsLoading(true);
    setParticipantsError("");
    try {
      const response = await fetch("/api/admin/participants", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw Object.assign(new Error(data?.error?.message ?? "无法读取参与者信息。"), { status: response.status });
      setParticipants(data.participants as ParticipantDirectoryRow[]);
    } catch (loadError) {
      if ((loadError as { status?: number }).status === 401) setMode("login");
      setParticipantsError(loadError instanceof Error ? loadError.message : "无法读取参与者信息。");
    } finally { setParticipantsLoading(false); }
  }, []);

  useEffect(() => {
    fetch("/api/admin/settings", { cache: "no-store" })
      .then(parseResponse)
      .then((data) => { setAdmin(data.admin); setSettings(data.settings); setMode("ready"); void loadParticipants(); })
      .catch(() => setMode("login"));
  }, [loadParticipants]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    try {
      await parseResponse(await fetch("/api/admin/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: form.get("username"), password: form.get("password") }),
      }));
    } catch (loginError) {
      // Login returns only the admin object; reload settings after authentication.
      if ((loginError as { status?: number }).status) { setError(loginError instanceof Error ? loginError.message : "登录失败。"); return; }
    }
    try {
      const data = await parseResponse(await fetch("/api/admin/settings", { cache: "no-store" }));
      setAdmin(data.admin); setSettings(data.settings); setMode("ready");
      void loadParticipants();
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : "无法读取实验设置。"); }
  }

  async function save() {
    if (!settings) return;
    setSaving(true); setError(""); setStatus("");
    try {
      const data = await parseResponse(await fetch("/api/admin/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experiment: settings.experiment,
          limits: settings.limits,
          storage: settings.storage,
          ai: { baseUrl: settings.ai.baseUrl, botId: settings.ai.botId },
        }),
      }));
      setSettings(data.settings); setStatus(`已保存为版本 ${data.settings.version}`);
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : "保存失败。"); }
    finally { setSaving(false); }
  }

  async function logout() {
    await fetch("/api/admin/logout", { method: "POST" });
    setAdmin(null); setSettings(null); setMode("login");
  }

  if (mode === "loading") return <div className="admin-loading"><span className="admin-brand-mark">E</span><p>正在载入管理后台…</p></div>;
  if (mode === "login") return <AdminLogin onSubmit={login} error={error} />;
  if (!settings || !admin) return null;

  const updateExperiment = (patch: Partial<ExperimentSettings["experiment"]>) => setSettings({ ...settings, experiment: { ...settings.experiment, ...patch } });
  const updateLimits = (patch: Partial<ExperimentSettings["limits"]>) => setSettings({ ...settings, limits: { ...settings.limits, ...patch } });
  const updateStorage = (patch: Partial<ExperimentSettings["storage"]>) => setSettings({ ...settings, storage: { ...settings.storage, ...patch } });

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span className="admin-brand-mark">E</span><span>EduLab</span></div>
        <div className="admin-context"><p>管理后台</p><strong>{settings.experiment.title}</strong><span>{settings.experiment.id} · v{settings.version}</span></div>
        <nav className="admin-nav" aria-label="设置导航">{sections.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => { setSection(item.id); if (item.id === "participants") void loadParticipants(); }}><span>{item.number}</span><div><strong>{item.label}</strong><small>{item.description}</small></div></button>)}</nav>
        <div className="admin-sidebar-footer"><div><span className="admin-online-dot" />{admin.displayName}</div><button onClick={logout}>退出</button></div>
      </aside>

      <section className="admin-main">
        <header className="admin-header"><div><p className="admin-kicker">{section === "participants" ? "研究数据" : "实验配置"}</p><h1>{sections.find((item) => item.id === section)?.label}</h1></div><div className="admin-header-actions">{section === "participants" ? <><span className="save-state">身份信息与对话记录分开保存</span><button className="admin-refresh" onClick={loadParticipants} disabled={participantsLoading}>{participantsLoading ? "读取中…" : "刷新"}</button></> : section === "ai" ? <span className="save-state">场次切换只影响之后进入的参与者</span> : <><span className={error ? "save-state error" : "save-state"}>{error || status || "设置只影响新创建的会话"}</span><button className="admin-save" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存设置"}</button></>}</div></header>
        <div className="admin-content">
          {section === "participants" && <ParticipantDirectory participants={participants} loading={participantsLoading} error={participantsError} onDeleted={(participantId) => setParticipants((current) => current.filter((participant) => participant.id !== participantId))} />}
          {section === "content" && <ContentSettings settings={settings} update={updateExperiment} />}
          {section === "limits" && <LimitSettings settings={settings} updateExperiment={updateExperiment} updateLimits={updateLimits} />}
          {section === "storage" && <StorageSettings settings={settings} update={updateStorage} />}
          {section === "ai" && <AgentRunSettings />}
        </div>
      </section>
    </main>
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function DangerConfirmation({ title, description, expectedValue, expectedLabel, busy, error, onCancel, onConfirm }: {
  title: string; description: string; expectedValue: string; expectedLabel: string;
  busy: boolean; error: string; onCancel: () => void; onConfirm: (confirmation: string) => void;
}) {
  const [confirmation, setConfirmation] = useState("");
  return <div className="danger-dialog-backdrop">
    <section className="danger-dialog" role="dialog" aria-modal="true" aria-labelledby="danger-dialog-title">
      <div className="danger-dialog-icon" aria-hidden="true">!</div>
      <div><p className="admin-kicker">危险操作</p><h2 id="danger-dialog-title">{title}</h2><p>{description}</p></div>
      <label><span>请输入{expectedLabel} <strong>{expectedValue}</strong> 以确认</span><input value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="off" /></label>
      {error && <p className="danger-dialog-error" role="alert">{error}</p>}
      <div className="danger-dialog-actions"><button className="admin-refresh" onClick={onCancel} disabled={busy}>取消</button><button className="admin-danger" onClick={() => onConfirm(confirmation)} disabled={busy || confirmation !== expectedValue}>{busy ? "正在删除…" : "永久删除"}</button></div>
    </section>
  </div>;
}

function ParticipantDirectory({ participants, loading, error, onDeleted }: {
  participants: ParticipantDirectoryRow[]; loading: boolean; error: string; onDeleted: (participantId: string) => void;
}) {
  const [pendingDelete, setPendingDelete] = useState<ParticipantDirectoryRow | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [deleteStatus, setDeleteStatus] = useState("");

  async function removeParticipant(confirmationCode: string) {
    if (!pendingDelete) return;
    setDeleting(true); setDeleteError(""); setDeleteStatus("");
    try {
      const response = await fetch("/api/admin/participants", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId: pendingDelete.id, confirmationCode }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? "删除失败。");
      if ("BroadcastChannel" in window) {
        const channel = new BroadcastChannel("edulab_session_events");
        channel.postMessage({ type: "participant_deleted", participantCode: pendingDelete.participantCode });
        channel.close();
      }
      onDeleted(pendingDelete.id);
      setDeleteStatus(`参与者 ${pendingDelete.participantCode} 的数据库记录已永久删除。`);
      setPendingDelete(null);
    } catch (removeError) { setDeleteError(removeError instanceof Error ? removeError.message : "删除失败。"); }
    finally { setDeleting(false); }
  }

  return <div className="settings-stack">
    {deleteStatus && <p className="agent-success" role="status">{deleteStatus}</p>}
    <section className="settings-card participant-directory">
      <div className="settings-card-head"><div><h2>参与者身份对应表</h2><p>姓名和学号经过加密后存储，并通过内部 Participant ID 与会话关联。聊天记录和学生导出的 JSON 不包含这些直接身份信息。</p></div><span className="secure-badge">仅管理员可见</span></div>
      {error ? <p className="directory-error" role="alert">{error}</p> : loading && participants.length === 0 ? <p className="directory-empty">正在读取参与者信息…</p> : participants.length === 0 ? <p className="directory-empty">还没有参与者进入实验。</p> : <div className="directory-table-wrap"><table className="directory-table"><thead><tr><th>Participant ID</th><th>姓名</th><th>学号</th><th>对话</th><th>轮次</th><th>最后活动</th><th>操作</th></tr></thead><tbody>{participants.map((participant) => <tr key={participant.id}><td><code>{participant.participantCode}</code></td><td>{participant.fullName || <span className="missing-value">未填写</span>}</td><td>{participant.studentNumber || <span className="missing-value">未填写</span>}</td><td>{participant.sessionCount}</td><td>{participant.turnCount}</td><td>{formatDate(participant.lastActivityAt)}</td><td><button className="table-danger" onClick={() => { setDeleteError(""); setPendingDelete(participant); }}>删除记录</button></td></tr>)}</tbody></table></div>}
    </section>
    <div className="security-note"><strong>访谈联系时如何对应</strong><p>交互数据继续使用 Participant ID。研究者只在需要联系参与者时，通过此表将 Participant ID 对应到姓名或学号，避免直接身份信息进入 AI 对话和导出文件。</p></div>
    {pendingDelete && <DangerConfirmation title={`删除 ${pendingDelete.participantCode} 的全部数据库记录？`} description={`将永久删除该参与者的身份对应、${pendingDelete.sessionCount} 个会话、${pendingDelete.turnCount} 个轮次、消息和智能体分配。此操作无法撤销。对应实验页面在返回前台或再次操作时会退出旧会话并清除该参与者的浏览器本地记录。`} expectedValue={pendingDelete.participantCode} expectedLabel="Participant ID" busy={deleting} error={deleteError} onCancel={() => setPendingDelete(null)} onConfirm={(confirmation) => void removeParticipant(confirmation)} />}
  </div>;
}

function AdminLogin({ onSubmit, error }: { onSubmit: (event: FormEvent<HTMLFormElement>) => void; error: string }) {
  return <main className="admin-login-page"><section className="admin-login-card"><div className="admin-login-brand"><span className="admin-brand-mark">E</span><div><strong>EduLab</strong><span>实验管理后台</span></div></div><div className="admin-login-copy"><p className="admin-kicker">管理员登录</p><h1>管理实验，不打扰实验</h1><p>登录后可以设置任务内容、交互限制和 Coze 智能体。所有更改都会留下版本与操作记录。</p></div><form onSubmit={onSubmit}><label><span>用户名</span><input name="username" autoComplete="username" required /></label><label><span>密码</span><input name="password" type="password" autoComplete="current-password" minLength={8} required /></label>{error && <p className="admin-login-error" role="alert">{error}</p>}<button type="submit">进入管理后台</button></form><p className="admin-login-note">学生无法通过此入口读取或修改实验设置。</p></section></main>;
}

function ContentSettings({ settings, update }: { settings: ExperimentSettings; update: (patch: Partial<ExperimentSettings["experiment"]>) => void }) {
  const value = settings.experiment;
  return <div className="settings-stack"><section className="settings-card optional-feature"><div className="settings-card-head"><div><h2>向学生提供任务说明</h2><p>通常保持关闭。开启后，学生可以在聊天页按需查看任务内容，不会占用对话列表侧栏。</p></div><label className="switch" aria-label="向学生提供任务说明"><input type="checkbox" checked={value.taskVisible} onChange={(event) => update({ taskVisible: event.target.checked })} /><span /></label></div></section>{value.taskVisible && <section className="settings-card"><div className="settings-card-head"><div><h2>可选任务内容</h2><p>仅在开启任务说明后显示给学生。</p></div><span className="field-status">新会话生效</span></div><div className="form-grid"><label><span>内部任务编号</span><input value={value.label} onChange={(event) => update({ label: event.target.value })} /></label><label className="wide"><span>任务标题</span><input value={value.title} onChange={(event) => update({ title: event.target.value })} /></label><label className="wide"><span>任务说明</span><textarea rows={3} value={value.introduction} onChange={(event) => update({ introduction: event.target.value })} /></label><label className="wide"><span>任务要求（每行一项）</span><textarea rows={4} value={value.requirements.join("\n")} onChange={(event) => update({ requirements: event.target.value.split("\n").map((item) => item.trim()).filter(Boolean) })} /></label><label className="wide"><span>学习材料</span><textarea rows={5} value={value.material} onChange={(event) => update({ material: event.target.value })} /></label><label className="wide"><span>必要提示</span><textarea rows={3} value={value.hint} onChange={(event) => update({ hint: event.target.value })} /></label><label><span>AI 显示名称</span><input value={value.assistantName} onChange={(event) => update({ assistantName: event.target.value })} /></label><label className="wide"><span>欢迎语</span><textarea rows={3} value={value.welcome} onChange={(event) => update({ welcome: event.target.value })} /></label></div></section>}</div>;
}

function LimitSettings({ settings, updateExperiment, updateLimits }: { settings: ExperimentSettings; updateExperiment: (patch: Partial<ExperimentSettings["experiment"]>) => void; updateLimits: (patch: Partial<ExperimentSettings["limits"]>) => void }) {
  const number = (value: string) => value === "" ? null : Math.max(1, Number(value));
  return <div className="settings-stack"><section className="settings-card"><div className="settings-card-head"><div><h2>交互限制</h2><p>学生页面会显示剩余次数、可输入字数和剩余时间。</p></div><span className="field-status">服务端强制执行</span></div><div className="limit-grid"><label><span>最多发送次数</span><div className="number-field"><input type="number" min="1" value={settings.limits.maxUserMessages ?? ""} onChange={(event) => updateLimits({ maxUserMessages: number(event.target.value) })} /><em>次</em></div><small>留空表示不限制</small></label><label><span>每条消息最多字数</span><div className="number-field"><input type="number" min="1" max="20000" value={settings.limits.maxMessageChars} onChange={(event) => updateLimits({ maxMessageChars: Math.max(1, Number(event.target.value)) })} /><em>字</em></div><small>超出后无法发送</small></label><label><span>实验交互时长</span><div className="number-field"><input type="number" min="1" value={settings.limits.sessionDurationMinutes ?? ""} onChange={(event) => updateLimits({ sessionDurationMinutes: number(event.target.value) })} /><em>分钟</em></div><small>从创建会话开始计算</small></label></div></section><section className="settings-card"><div className="settings-card-head"><div><h2>聊天功能</h2><p>关闭后保留任务阅读页面，但学生不能发送消息。</p></div><label className="switch" aria-label="开放聊天功能"><input type="checkbox" checked={settings.experiment.chatEnabled} onChange={(event) => updateExperiment({ chatEnabled: event.target.checked })} /><span /></label></div>{!settings.experiment.chatEnabled && !settings.experiment.taskVisible && <p className="inline-warning">任务区域和聊天区域不能同时关闭。</p>}</section></div>;
}

function StorageSettings({ settings, update }: { settings: ExperimentSettings; update: (patch: Partial<ExperimentSettings["storage"]>) => void }) {
  const enabled = settings.storage.databaseMessagesEnabled;
  return <div className="settings-stack"><section className={`settings-card ${enabled ? "" : "storage-disabled"}`}><div className="settings-card-head"><div><h2>实验结束时备份完整对话到数据库</h2><p>聊天期间正文只保存在当前浏览器，不在 AI 回复关键路径上读写 PostgreSQL。</p></div><label className="switch" aria-label="实验结束时备份完整对话到数据库"><input type="checkbox" checked={enabled} onChange={(event) => update({ databaseMessagesEnabled: event.target.checked })} /><span /></label></div><div className="storage-mode"><strong>{enabled ? "浏览器本地记录 + 人工导出 + 结束时数据库备份" : "仅使用浏览器本地记录与人工导出"}</strong><p>{enabled ? "达到时间或次数限制、切换参与者或关闭页面时，系统才提交当前完整记录。数据库网络不会延迟正常的 AI 回复。" : "数据库不保存学生和 AI 的消息正文。请确保参与者完成前下载并提交交互记录。"}</p></div></section><div className="security-note"><strong>刷新不会清除当前会话记录</strong><p>每条已显示的消息都会同步到当前浏览器的本地存储，页面刷新后会自动恢复。但更换设备、清除浏览器数据或使用隐私模式仍可能丢失本地副本。</p></div><div className="security-note"><strong>进入实验仍需要数据库</strong><p>Participant ID、身份对应关系和当前场次在进入实验时创建；进入后发送消息使用加密运行配置直接调用 Coze。数据库中断可能影响新参与者进入和最终备份，但不会延迟已经进入场次的学生获得 AI 回复。</p></div></div>;
}

function AgentRunSettings() {
  const [control, setControl] = useState<AgentControl | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [runName, setRunName] = useState("");
  const [assignmentMode, setAssignmentMode] = useState<"fixed" | "balanced_random">("fixed");
  const [fixedAgentId, setFixedAgentId] = useState("");
  const [randomAgentIds, setRandomAgentIds] = useState<string[]>([]);

  useEffect(() => {
    void fetch("/api/admin/agent-control", { cache: "no-store" })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data?.error?.message ?? "无法读取智能体配置。");
        setControl(data.control as AgentControl);
      })
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : "无法读取智能体配置。"));
  }, []);

  async function post(body: unknown, success: string) {
    setBusy(true); setError(""); setStatus("");
    try {
      const response = await fetch("/api/admin/agent-control", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? "保存失败。");
      setControl(data.control as AgentControl); setStatus(success); setAdding(false);
    } catch (postError) { setError(postError instanceof Error ? postError.message : "保存失败。"); }
    finally { setBusy(false); }
  }

  async function removeAgent(agent: AgentSummary, confirmationName: string) {
    setBusy(true); setError(""); setStatus("");
    try {
      const response = await fetch("/api/admin/agent-control", {
        method: "DELETE", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentId: agent.id, confirmationName }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error?.message ?? "删除失败。");
      setControl(data.control as AgentControl); setStatus(`智能体“${agent.internalName}”已永久删除。`);
      return true;
    } catch (removeError) { setError(removeError instanceof Error ? removeError.message : "删除失败。"); return false; }
    finally { setBusy(false); }
  }

  if (!control) return <div className="settings-stack"><section className="settings-card"><p>{error || "正在读取智能体和场次…"}</p></section></div>;
  const enabledAgents = control.agents.filter((agent) => agent.enabled && agent.hasToken);
  const activeAgentIds = new Set(control.activeRun?.assignmentMode === "fixed"
    ? [control.activeRun.fixedAgentId].filter((value): value is string => Boolean(value))
    : control.activeRun?.randomAgentIds ?? []);

  return <div className="settings-stack agent-run-settings">
    {(error || status) && <p className={error ? "directory-error" : "agent-success"} role={error ? "alert" : "status"}>{error || status}</p>}
    <section className="settings-card active-run-card">
      <div className="settings-card-head"><div><h2>当前开放场次</h2><p>学生填写信息时被分配到当时开放的场次；已经开始的 Session 不会因后台切换而改变智能体。</p></div><span className={control.activeRun ? "secure-badge" : "field-status"}>{control.activeRun ? "正在开放" : "尚未开放"}</span></div>
      {control.activeRun ? <div className="active-run-summary"><div><span>场次名称</span><strong>{control.activeRun.name}</strong></div><div><span>分配方式</span><strong>{control.activeRun.assignmentMode === "fixed" ? "固定智能体" : "均衡随机分配"}</strong></div><div><span>使用智能体</span><strong>{[...activeAgentIds].map((id) => control.agents.find((agent) => agent.id === id)?.internalName ?? id).join("、")}</strong></div><button className="admin-refresh" disabled={busy} onClick={() => { if (window.confirm("结束后，新学生将暂时无法进入实验，已经开始的 Session 保持原配置。确认结束当前场次吗？")) void post({ action: "close_active_run" }, "当前场次已结束。"); }}>结束当前场次</button></div> : <p className="inline-warning">没有开放场次时，新参与者不能开始实验。</p>}
    </section>

    <section className="settings-card">
      <div className="settings-card-head"><div><h2>开放新场次</h2><p>适合在每节课开始前操作。开放新场次时，系统会自动关闭之前的场次。</p></div><span className="field-status">新参与者生效</span></div>
      <div className="form-grid run-form"><label className="wide"><span>场次名称</span><input value={runName} onChange={(event) => setRunName(event.target.value)} placeholder="例如：第二节课 · 智能体 B" /></label><label><span>分配方式</span><select value={assignmentMode} onChange={(event) => setAssignmentMode(event.target.value as "fixed" | "balanced_random")}><option value="fixed">固定智能体</option><option value="balanced_random">均衡随机分配</option></select></label>{assignmentMode === "fixed" ? <label><span>指定智能体</span><select value={fixedAgentId} onChange={(event) => setFixedAgentId(event.target.value)}><option value="">请选择</option>{enabledAgents.map((agent) => <option key={agent.id} value={agent.id}>{agent.internalName}</option>)}</select></label> : <fieldset className="wide agent-choice-field"><legend>参与随机分配的智能体（至少两个）</legend>{enabledAgents.map((agent) => <label key={agent.id}><input type="checkbox" checked={randomAgentIds.includes(agent.id)} onChange={(event) => setRandomAgentIds(event.target.checked ? [...randomAgentIds, agent.id] : randomAgentIds.filter((id) => id !== agent.id))} /><span>{agent.internalName}</span></label>)}</fieldset>}</div>
      <button className="admin-save run-activate-button" disabled={busy || !runName.trim() || (assignmentMode === "fixed" ? !fixedAgentId : randomAgentIds.length < 2)} onClick={() => { const selected = assignmentMode === "fixed" ? control.agents.find((agent) => agent.id === fixedAgentId)?.internalName : `${randomAgentIds.length} 个智能体均衡随机`; if (window.confirm(`即将开放“${runName}”，使用${selected ?? "所选配置"}。这只影响之后进入的参与者。确认继续吗？`)) void post({ action: "activate_run", run: { name: runName, assignmentMode, fixedAgentId: assignmentMode === "fixed" ? fixedAgentId : null, randomAgentIds: assignmentMode === "balanced_random" ? randomAgentIds : [] } }, `场次“${runName}”已开放。`); }}>开放这个场次</button>
    </section>

    <section className="settings-card">
      <div className="settings-card-head"><div><h2>Coze 智能体配置</h2><p>内部名称只在后台和研究数据中使用；学生端统一显示为学习助理。Token 加密保存且不会回显。</p></div><button className="admin-refresh" onClick={() => setAdding(true)} disabled={busy}>新增智能体</button></div>
      <div className="agent-config-list">{control.agents.map((agent) => <AgentEditor key={`${agent.id}-${agent.updatedAt}`} agent={agent} locked={activeAgentIds.has(agent.id)} busy={busy} onDelete={(confirmationName) => removeAgent(agent, confirmationName)} onSave={(value) => post({ action: "save_agent", agent: value }, `智能体“${value.internalName}”已保存。`)} />)}{adding && <AgentEditor agent={null} locked={false} busy={busy} onCancel={() => setAdding(false)} onSave={(value) => post({ action: "save_agent", agent: value }, `智能体“${value.internalName}”已添加。`)} />}</div>
    </section>
    <div className="security-note"><strong>聊天期间不读取数据库配置</strong><p>学生进入场次时，服务端会把已选智能体和限制生成加密、HttpOnly 的运行配置。之后发送消息直接调用 Coze；对话正文保存在浏览器，并在结束、切换参与者或关闭页面时上传数据库备份。</p></div>
  </div>;
}

function AgentEditor({ agent, locked, busy, onSave, onDelete, onCancel }: { agent: AgentSummary | null; locked: boolean; busy: boolean; onSave: (value: { id?: string; internalName: string; baseUrl: string; botId: string; token?: string; enabled: boolean }) => void; onDelete?: (confirmationName: string) => Promise<boolean>; onCancel?: () => void }) {
  const [internalName, setInternalName] = useState(agent?.internalName ?? "");
  const [baseUrl, setBaseUrl] = useState(agent?.baseUrl ?? "https://api.coze.cn");
  const [botId, setBotId] = useState(agent?.botId ?? "");
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(agent?.enabled ?? true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  return <div className={`agent-config-card ${locked ? "locked" : ""}`}><div className="agent-config-title"><strong>{agent?.internalName || "新智能体"}</strong><span>{locked ? "当前场次已锁定" : agent?.hasReferences ? "已有历史关联，只能停用" : agent?.hasToken ? "Token 已配置" : "需要 Token"}</span></div><div className="form-grid"><label><span>内部名称</span><input value={internalName} onChange={(event) => setInternalName(event.target.value)} disabled={locked} placeholder="例如：智能体 B" /></label><label><span>API 地址</span><input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} disabled={locked} /></label><label className="wide"><span>Bot ID</span><input value={botId} onChange={(event) => setBotId(event.target.value)} disabled={locked} placeholder="Coze Bot ID" /></label><label className="wide"><span>API Token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} disabled={locked} autoComplete="new-password" placeholder={agent?.hasToken ? "留空则保持现有 Token" : "输入 Coze API Token"} /></label><label className="agent-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} disabled={locked} /><span>允许用于新场次</span></label></div><div className="agent-editor-actions">{agent && onDelete && <button className="admin-danger-secondary" disabled={busy || locked || agent.hasReferences} title={agent.hasReferences ? "已有场次或历史会话引用，不能删除；可以取消启用后保存" : undefined} onClick={() => { setDeleteError(""); setDeleteOpen(true); }}>删除智能体</button>}{onCancel && <button className="admin-refresh" onClick={onCancel}>取消</button>}<button className="admin-save" disabled={busy || locked || !internalName.trim() || !botId.trim() || (!agent?.hasToken && !token.trim())} onClick={() => onSave({ ...(agent ? { id: agent.id } : {}), internalName, baseUrl, botId, ...(token.trim() ? { token } : {}), enabled })}>保存智能体</button></div>{deleteOpen && agent && onDelete && <DangerConfirmation title={`删除智能体“${agent.internalName}”？`} description="将永久删除该智能体的 API 地址、Bot ID 和加密 Token。只有从未被场次或历史会话引用的智能体才能删除，此操作无法撤销。" expectedValue={agent.internalName} expectedLabel="智能体名称" busy={busy} error={deleteError} onCancel={() => setDeleteOpen(false)} onConfirm={(confirmation) => { void onDelete(confirmation).then((deleted) => { if (deleted) setDeleteOpen(false); else setDeleteError("删除未完成，请查看页面上方的原因。"); }); }} />}</div>;
}
