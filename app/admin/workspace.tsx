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

const sections: Array<{ id: Section; number: string; label: string; description: string }> = [
  { id: "participants", number: "01", label: "参与者", description: "身份与编号对应表" },
  { id: "limits", number: "02", label: "交互规则", description: "次数、字数与时长" },
  { id: "ai", number: "03", label: "AI 接入", description: "Coze 智能体设置" },
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
  const [token, setToken] = useState("");
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
          ai: { baseUrl: settings.ai.baseUrl, botId: settings.ai.botId, ...(token.trim() ? { token } : {}) },
        }),
      }));
      setSettings(data.settings); setToken(""); setStatus(`已保存为版本 ${data.settings.version}`);
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
  const updateAi = (patch: Partial<ExperimentSettings["ai"]>) => setSettings({ ...settings, ai: { ...settings.ai, ...patch } });

  return (
    <main className="admin-shell">
      <aside className="admin-sidebar">
        <div className="admin-brand"><span className="admin-brand-mark">E</span><span>EduLab</span></div>
        <div className="admin-context"><p>管理后台</p><strong>{settings.experiment.title}</strong><span>{settings.experiment.id} · v{settings.version}</span></div>
        <nav className="admin-nav" aria-label="设置导航">{sections.map((item) => <button className={section === item.id ? "active" : ""} key={item.id} onClick={() => { setSection(item.id); if (item.id === "participants") void loadParticipants(); }}><span>{item.number}</span><div><strong>{item.label}</strong><small>{item.description}</small></div></button>)}</nav>
        <div className="admin-sidebar-footer"><div><span className="admin-online-dot" />{admin.displayName}</div><button onClick={logout}>退出</button></div>
      </aside>

      <section className="admin-main">
        <header className="admin-header"><div><p className="admin-kicker">{section === "participants" ? "研究数据" : "实验配置"}</p><h1>{sections.find((item) => item.id === section)?.label}</h1></div><div className="admin-header-actions">{section === "participants" ? <><span className="save-state">身份信息与对话记录分开保存</span><button className="admin-refresh" onClick={loadParticipants} disabled={participantsLoading}>{participantsLoading ? "读取中…" : "刷新"}</button></> : <><span className={error ? "save-state error" : "save-state"}>{error || status || "设置只影响新创建的会话"}</span><button className="admin-save" onClick={save} disabled={saving}>{saving ? "保存中…" : "保存设置"}</button></>}</div></header>
        <div className="admin-content">
          {section === "participants" && <ParticipantDirectory participants={participants} loading={participantsLoading} error={participantsError} />}
          {section === "content" && <ContentSettings settings={settings} update={updateExperiment} />}
          {section === "limits" && <LimitSettings settings={settings} updateExperiment={updateExperiment} updateLimits={updateLimits} />}
          {section === "storage" && <StorageSettings settings={settings} update={updateStorage} />}
          {section === "ai" && <AiSettings settings={settings} update={updateAi} token={token} setToken={setToken} />}
        </div>
      </section>
    </main>
  );
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

function ParticipantDirectory({ participants, loading, error }: { participants: ParticipantDirectoryRow[]; loading: boolean; error: string }) {
  return <div className="settings-stack"><section className="settings-card participant-directory"><div className="settings-card-head"><div><h2>参与者身份对应表</h2><p>姓名和学号经过加密后存储，并通过内部 Participant ID 与会话关联。聊天记录和学生导出的 JSON 不包含这些直接身份信息。</p></div><span className="secure-badge">仅管理员可见</span></div>{error ? <p className="directory-error" role="alert">{error}</p> : loading && participants.length === 0 ? <p className="directory-empty">正在读取参与者信息…</p> : participants.length === 0 ? <p className="directory-empty">还没有参与者进入实验。</p> : <div className="directory-table-wrap"><table className="directory-table"><thead><tr><th>Participant ID</th><th>姓名</th><th>学号</th><th>对话</th><th>轮次</th><th>最后活动</th></tr></thead><tbody>{participants.map((participant) => <tr key={participant.id}><td><code>{participant.participantCode}</code></td><td>{participant.fullName || <span className="missing-value">未填写</span>}</td><td>{participant.studentNumber || <span className="missing-value">未填写</span>}</td><td>{participant.sessionCount}</td><td>{participant.turnCount}</td><td>{formatDate(participant.lastActivityAt)}</td></tr>)}</tbody></table></div>}</section><div className="security-note"><strong>访谈联系时如何对应</strong><p>交互数据继续使用 Participant ID。研究者只在需要联系参与者时，通过此表将 Participant ID 对应到姓名或学号，避免直接身份信息进入 AI 对话和导出文件。</p></div></div>;
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
  return <div className="settings-stack"><section className={`settings-card ${enabled ? "" : "storage-disabled"}`}><div className="settings-card-head"><div><h2>后台保存完整对话到数据库</h2><p>AI 回复先展示给学生，随后异步整理消息，不让数据库保存阻塞回复显示。</p></div><label className="switch" aria-label="后台保存完整对话到数据库"><input type="checkbox" checked={enabled} onChange={(event) => update({ databaseMessagesEnabled: event.target.checked })} /><span /></label></div><div className="storage-mode"><strong>{enabled ? "浏览器本地副本 + 数据库后台同步 + 人工导出" : "仅使用浏览器本地记录与人工导出"}</strong><p>{enabled ? "每轮回复显示后，完整内容和时间信息会在后台同步到 PostgreSQL；达到时间或次数限制时自动完成最终整理，离开页面时还会再发送一次检查点。" : "数据库不保存学生和 AI 的消息正文，但仍保留 Session、请求状态、时间与 Coze 标识。请确保参与者完成前下载并提交交互记录。"}</p></div></section><div className="security-note"><strong>刷新不会清除当前会话记录</strong><p>每条已显示的消息都会同步到当前浏览器的本地存储，页面刷新后会自动恢复。但更换设备、清除浏览器数据或使用隐私模式仍可能丢失本地副本。</p></div><div className="security-note"><strong>这个开关不能替代数据库连接</strong><p>EduLab 仍依赖 PostgreSQL 创建安全 Session、执行次数限制和防止重复请求；Coze 也仍会接收对话以维持多轮上下文。</p></div></div>;
}

function AiSettings({ settings, update, token, setToken }: { settings: ExperimentSettings; update: (patch: Partial<ExperimentSettings["ai"]>) => void; token: string; setToken: (value: string) => void }) {
  return <div className="settings-stack"><section className="settings-card secure"><div className="settings-card-head"><div><h2>Coze 智能体</h2><p>Token 使用 AES-256-GCM 加密保存，保存后不会再显示明文。</p></div><span className="secure-badge">{settings.ai.hasToken ? "Token 已配置" : "尚未配置 Token"}</span></div><div className="form-grid"><label className="wide"><span>API 地址</span><input value={settings.ai.baseUrl} onChange={(event) => update({ baseUrl: event.target.value })} /></label><label className="wide"><span>Bot ID</span><input value={settings.ai.botId} onChange={(event) => update({ botId: event.target.value })} placeholder="输入已发布智能体的 Bot ID" /></label><label className="wide"><span>API Token</span><input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="new-password" placeholder={settings.ai.hasToken ? "••••••••••••••••  留空则保持不变" : "输入 Coze API Token"} /></label></div></section><div className="security-note"><strong>数据库连接不在这里设置</strong><p>数据库凭证属于平台基础设施，仍由 Vercel 环境变量管理。后台管理员无需接触数据库账号即可管理实验。</p></div></div>;
}
