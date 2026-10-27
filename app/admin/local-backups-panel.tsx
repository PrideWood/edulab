"use client";

import { useEffect, useRef, useState } from "react";
import type { LocalBackupRow } from "@/lib/local-backups";
import type { LocalBackupReference } from "@/lib/local-backup-export";

type Message = { id: string; role: string; content: string; sent_at: string; turn_index: number; sequence_no: number };
type Archive = { participant: { name: string }; conversations: Array<{
  id: string; title: string; created_at: string; messages: Message[];
  requests: Array<{ id: string; turn_index: number; status: string }>;
}> };
const sourceName = (source: string) => source === "teacher-lan" ? "教师机局域网" : "学生机轻量版";
const className = (code: string) => (({ "3": "三班", "8": "八班", "9": "九班" })[code] ?? code) || "—";
const date = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const recordKey = (row: LocalBackupReference) => `${row.deviceId}:${row.participantId}`;

export function LocalBackupsPanel() {
  const [source, setSource] = useState("");
  const [classCode, setClassCode] = useState("");
  const [search, setSearch] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [page, setPage] = useState(1);
  const [refresh, setRefresh] = useState(0);
  const [data, setData] = useState<{ initialized: boolean; records: LocalBackupRow[]; total: number; pageSize: number } | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<LocalBackupRow | null>(null);
  const [checked, setChecked] = useState<Record<string, LocalBackupReference>>({});
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const [exportStatus, setExportStatus] = useState("");
  const selectedRecords = Object.values(checked);
  const allOnPage = Boolean(data?.records.length) && Boolean(data?.records.every(row => checked[recordKey(row)]));

  function resetSelection() { setChecked({}); setExportError(""); setExportStatus(""); }
  function toggle(row: LocalBackupRow) {
    setChecked(current => {
      const next = { ...current }, key = recordKey(row);
      if (next[key]) delete next[key];
      else next[key] = { deviceId: row.deviceId, participantId: row.participantId };
      return next;
    });
  }
  function togglePage() {
    setChecked(current => {
      const next = { ...current };
      for (const row of data?.records ?? []) {
        if (allOnPage) delete next[recordKey(row)];
        else next[recordKey(row)] = { deviceId: row.deviceId, participantId: row.participantId };
      }
      return next;
    });
  }
  async function exportRecords(records: LocalBackupReference[]) {
    if (!records.length || exporting) return;
    setExporting(true); setExportError(""); setExportStatus("");
    try {
      const response = await fetch("/api/admin/local-backups", { method: "POST",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ records }) });
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error?.message ?? "导出失败，请稍后重试。");
      }
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url;
      link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "EduLab_local_interactions.zip";
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      setExportStatus(`已导出 ${Number(response.headers.get("X-EduLab-Export-Count")) || records.length} 位参与者的完整云端交互记录。`);
    } catch (failure) { setExportError(failure instanceof Error ? failure.message : "导出失败。"); }
    finally { setExporting(false); }
  }

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ page: String(page) });
    if (source) params.set("source", source);
    if (classCode) params.set("classCode", classCode);
    if (appliedSearch) params.set("search", appliedSearch);
    async function load() {
      setBusy(true); setError("");
      try {
        const response = await fetch(`/api/admin/local-backups?${params}`, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? "无法读取本地版备份。");
        if (!controller.signal.aborted) setData(result);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "无法读取备份。");
      } finally { if (!controller.signal.aborted) setBusy(false); }
    }
    void load();
    return () => controller.abort();
  }, [source, classCode, appliedSearch, page, refresh]);

  return <section className="settings-card local-backups-panel">
    <div className="settings-card-head"><div><h2>本地版云端备份</h2><p>汇总学生机与教师机已上传的记录，独立于左侧当前实验及原有 P/T 编号。</p></div><button className="admin-refresh" disabled={busy} onClick={() => setRefresh(value => value + 1)}>{busy ? "读取中…" : "刷新备份"}</button></div>
    <form className="local-backup-filters" onSubmit={event => { event.preventDefault(); resetSelection(); setPage(1); setAppliedSearch(search.trim()); setRefresh(value => value + 1); }}>
      <label>来源<select value={source} onChange={event => { resetSelection(); setSource(event.target.value); setPage(1); }}><option value="">全部来源</option><option value="student-light">学生机轻量版</option><option value="teacher-lan">教师机局域网</option></select></label>
      <label>班级<select value={classCode} onChange={event => { resetSelection(); setClassCode(event.target.value); setPage(1); }}><option value="">全部班级</option><option value="3">三班</option><option value="8">八班</option><option value="9">九班</option></select></label>
      <label>姓名<input value={search} onChange={event => setSearch(event.target.value)} maxLength={100} placeholder="如：测试" /></label><button className="admin-refresh" type="submit">查询</button>
    </form>
    <p className="profile-hint">这里显示云端已确认的最新快照；本机尚未上传的记录不会出现在此处。同名学生按设备和参与者标识区分。</p>
    {error && <p role="alert" className="local-backup-error">{error}</p>}
    {!error && data?.initialized === false && <p role="status">当前数据库尚未初始化本地版备份，请确认连接的是已接入备份的 Neon 数据库。</p>}
    {!error && data?.initialized && <>
      <p role="status">共 {data.total} 位参与者的备份{busy ? " · 正在刷新…" : ""}</p>
      <div className="participant-export-toolbar"><div><strong>已选择 {selectedRecords.length} 位</strong><span>全选当前页；翻页保留选择，切换筛选条件清空。一次最多导出 500 位，每人一个完整 JSON。</span></div><div><button className="admin-refresh" disabled={!selectedRecords.length || exporting} onClick={resetSelection}>清空选择</button><button className="participant-export-button" disabled={!selectedRecords.length || selectedRecords.length > 500 || exporting || busy} onClick={() => void exportRecords(selectedRecords)}>{exporting ? "正在整理…" : "导出交互记录 (.zip)"}</button></div></div>
      {exportError && <p className="local-backup-error" role="alert">{exportError}</p>}
      {exportStatus && <p className="agent-success" role="status">{exportStatus}</p>}
      <div className="local-backup-table-wrap"><table className="local-backup-table"><thead><tr><th><BackupCheckbox checked={allOnPage} mixed={!allOnPage && data.records.some(row => checked[recordKey(row)])} disabled={busy || exporting || !data.records.length} label="全选当前页备份" onChange={togglePage} /></th><th>姓名 / 标识</th><th>班级</th><th>来源</th><th>会话 / 轮次 / 消息</th><th>云端接收时间</th><th>操作</th></tr></thead><tbody>
        {data.records.map(row => <tr key={recordKey(row)}><td><BackupCheckbox checked={Boolean(checked[recordKey(row)])} disabled={busy || exporting} label={`选择 ${row.participantName} ${row.deviceId} ${row.participantId}`} onChange={() => toggle(row)} /></td><td><strong>{row.participantName}</strong>{row.isTest && <span className="local-backup-tag">测试</span>}<small title={`设备 ${row.deviceId}\n参与者 ${row.participantId}`}>{row.deviceId.slice(0,8)} / {row.participantId.slice(0,8)}</small></td><td>{className(row.classCode)}</td><td>{sourceName(row.sourceApp)}</td><td>{row.conversationCount} / {row.turnCount} / {row.messageCount}</td><td>{date(row.receivedAt)}<small>快照生成：{date(row.exportedAt)}</small></td><td><div className="local-backup-row-actions"><button className="admin-refresh" onClick={() => setSelected(row)}>查看记录</button><button className="admin-refresh" disabled={exporting || busy} onClick={() => void exportRecords([row])}>导出交互记录</button></div></td></tr>)}
      </tbody></table></div>
      {!busy && !data.records.length && <p>没有符合条件的云端备份。</p>}
      <div className="local-backup-pagination"><button className="admin-refresh" disabled={busy || page <= 1} onClick={() => setPage(value => value - 1)}>上一页</button><span>第 {page} / {Math.max(1, Math.ceil(data.total / data.pageSize))} 页</span><button className="admin-refresh" disabled={busy || page * data.pageSize >= data.total} onClick={() => setPage(value => value + 1)}>下一页</button></div>
    </>}
    {selected && <BackupDetail key={`${selected.deviceId}:${selected.participantId}`} record={selected} onClose={() => setSelected(null)} />}
  </section>;
}

function BackupCheckbox({ checked, mixed = false, disabled, label, onChange }: {
  checked: boolean; mixed?: boolean; disabled: boolean; label: string; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <input ref={ref} className="local-backup-checkbox" type="checkbox" checked={checked} disabled={disabled} aria-label={label} onChange={onChange} />;
}

function BackupDetail({ record, onClose }: { record: LocalBackupRow; onClose: () => void }) {
  const [archive, setArchive] = useState<Archive | null>(null);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const endpoint = `/api/admin/local-backups?deviceId=${record.deviceId}&participantId=${record.participantId}`;
  useEffect(() => {
    const controller = new AbortController();
    const previous = document.activeElement;
    close.current?.focus({ preventScroll: true });
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const controls = dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]');
        if (!controls?.length) return;
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", keyboard);
    async function load() {
      try {
        const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
        const result = await response.json();
        if (!response.ok) throw new Error(result?.error?.message ?? "无法读取记录。");
        if (!controller.signal.aborted) setArchive(result.archive);
      } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "读取失败。"); }
    }
    void load();
    return () => { controller.abort(); document.removeEventListener("keydown", keyboard); if (previous instanceof HTMLElement) previous.focus({ preventScroll: true }); };
  }, [endpoint, onClose]);
  return <div className="danger-dialog-backdrop"><section ref={dialog} className="danger-dialog participant-record-dialog local-backup-detail" role="dialog" aria-modal="true" aria-labelledby="local-backup-title">
    <div className="participant-record-head"><div><h2 id="local-backup-title">{record.participantName} 的备份记录</h2><p>{className(record.classCode)} · {sourceName(record.sourceApp)} · 快照版本 {record.revision}</p></div><button ref={close} className="admin-refresh" onClick={onClose}>关闭</button></div>
    {error && <p role="alert">{error}</p>}
    {!archive && !error && <p role="status">正在读取完整记录…</p>}
    {archive && <><a className="admin-refresh local-backup-download" href={`${endpoint}&download=1`}>下载完整 JSON</a>
      {archive.conversations.map(conversation => <section className="local-backup-conversation" key={conversation.id}><h3>{conversation.title || "新对话"}</h3><p>{date(conversation.created_at)}</p>{conversation.messages.map(message => <article className="local-backup-message" key={message.id}><header><strong>{message.role === "user" ? "学生" : message.role === "assistant" ? "AI" : message.role}</strong><span>第 {message.turn_index} 轮 · 顺序 {message.sequence_no} · {date(message.sent_at)}</span></header><div>{message.content}</div></article>)}{!conversation.messages.length && <p>该会话尚无消息。</p>}</section>)}
    </>}
  </section></div>;
}
