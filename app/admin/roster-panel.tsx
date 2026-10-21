"use client";

import { useEffect, useState } from "react";
import { allocateRoster, parseRosterText, rosterCsv, STRATA, type RosterStudent } from "@/lib/roster-allocation";
import type { getRosters } from "@/lib/roster";

type Plan = Awaited<ReturnType<typeof getRosters>>[number];
type Agent = {id:string;internalName:string;enabled:boolean;hasToken:boolean};
const template="班级,参与姓名,前测成绩\n一班,张三1,92\n一班,张三2,76\n一班,李四,58\n二班,王五,85";
function download(content:Blob,filename:string) {
  const url=URL.createObjectURL(content), anchor=document.createElement("a");
  anchor.href=url;anchor.download=filename;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const number=(value:number|null)=>value===null?"—":value.toFixed(2);

export function RosterPanel({experimentId,agents,onChanged}:{experimentId:string;agents:Agent[];onChanged:()=>void}) {
  const endpoint=`/api/admin/rosters?experimentId=${encodeURIComponent(experimentId)}`;
  const [plans,setPlans]=useState<Plan[]>([]), [selected,setSelected]=useState<Plan|null>(null);
  const [name,setName]=useState("名单分层实验"), [agentIds,setAgentIds]=useState<string[]>([]);
  const [text,setText]=useState(""), [manual,setManual]=useState(false);
  const [adjusted,setAdjusted]=useState<RosterStudent[]|null>(null);
  const [busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[error,setError]=useState(""),[status,setStatus]=useState("");
  const [page,setPage]=useState(0),[agentFilter,setAgentFilter]=useState("");
  const [appendText,setAppendText]=useState("");
  const [confirmation,setConfirmation]=useState<"lock"|"append"|"export"|"delete"|null>(null);
  const [appendPreview,setAppendPreview]=useState<RosterStudent[]>([]),[deleteCode,setDeleteCode]=useState("");
  const [ready,setReady]=useState(false),[importedFile,setImportedFile]=useState("");
  useEffect(()=>{
    let live=true;
    fetch(endpoint,{cache:"no-store"}).then(async response=>{
      const data=await response.json();if(!response.ok)throw new Error(data.error?.message ?? "名单读取失败。");
      if(live){setPlans(data.rosters);setReady(true);}
    }).catch(error=>{if(live)setError(error.message);});
    return ()=>{live=false;};
  },[endpoint]);
  function choose(plan:Plan) {
    setSelected(plan);setName(plan.name);setAgentIds(plan.agentIds);setManual(plan.manual);
    setText(rosterCsv([["班级","参与姓名","前测成绩","层级","agentId"],...plan.students.map(row=>[row.className,row.fullName,row.score,row.stratum,row.agentId])]));
    setAdjusted(null);setDirty(false);setPage(0);setAgentFilter("");setError("");setStatus("");setImportedFile("");
  }
  async function perform(body:Record<string,unknown>) {
    if(busy)return;
    setBusy(true);setError("");setStatus("");
    try {
      const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
      if((body.action==="export" || body.action==="interactions_export") && response.ok){download(await response.blob(),body.action==="export"?"名单分层分配.csv":"智能体组交互记录.zip");setConfirmation(null);setStatus("数据已导出。");return;}
      const data=await response.json();if(!response.ok)throw new Error(data.error?.message ?? "操作失败。");
      setPlans(data.rosters);
      const plan=(data.rosters as Plan[]).find(plan=>plan.id===body.runId) ?? (data.rosters as Plan[]).find(plan=>!plan.entryDeletedAt);
      if(plan)choose(plan);
      setConfirmation(null);setAppendText("");onChanged();setStatus(body.action==="save"?"草案已保存，请核对下方分配后锁定开放。":"操作已完成。");
    }catch(error){setError(error instanceof Error?error.message:"操作失败。");}
    finally{setBusy(false);}
  }
  function save() {
    try {
      const students=adjusted ?? parseRosterText(text).map(row=>({...row,agentId:row.agentId ? agents.find(agent=>agent.id===row.agentId || agent.internalName===row.agentId)?.id ?? row.agentId : undefined}));
      void perform({action:"save",...(selected?{runId:selected.id}:{}),version:selected?.version ?? 0,name,agentIds,students,manual:adjusted ? true:manual});
    }catch(error){setError(error instanceof Error?error.message:"导入失败。");}
  }
  const readonly=Boolean(selected?.locked || selected?.entryDeletedAt);
  const students=adjusted ?? selected?.students ?? [];
  const classes=[...new Set(students.map(row=>row.className))];
  const label=(id:string)=>agents.find(agent=>agent.id===id)?.internalName ?? id;
  const filteredStudents=students.filter(row=>!agentFilter || row.agentId===agentFilter);
  const active=plans.find(plan=>!plan.entryDeletedAt);
  if (!ready) return <section className="settings-card roster-panel"><h2>名单分层预分配</h2>
    <p className={`roster-status${error ? " error" : ""}`} role={error ? "alert" : "status"}>{error || "正在读取名单设置…"}</p></section>;
  return <section className="settings-card roster-panel" aria-labelledby="roster-heading">
    <div className="settings-card-head"><div><h2 id="roster-heading">名单分层预分配</h2><p>导入各班前测名单，预览智能体分配，核对后锁定并开放统一入口。</p></div></div>
    {error && <p className="roster-status error" role="alert">{error}</p>}{status && <p className="roster-status success" role="status">{status}</p>}
    {plans.length>0 && <label className="roster-choice"><span>名单方案</span><select value={selected?.id ?? ""} disabled={busy} onChange={event=>{const plan=plans.find(plan=>plan.id===event.target.value);if(plan)choose(plan);}}><option value="">请选择已有方案</option>{plans.map(plan=><option key={plan.id} value={plan.id}>{plan.name} · v{plan.version} · {plan.entryDeletedAt?"链接已删除":plan.locked?plan.status==="active"?"已锁定，开放中":"已锁定，停止报名":"草案"}</option>)}</select></label>}
    {!selected && active ? <p className="profile-hint">此实验已有名单方案，请选择后查看或编辑；同一实验只保留一个有效的统一名单入口。</p> : <>
      <div className="form-grid roster-setup"><label className="roster-name-field"><span>方案名称</span><input value={name} maxLength={120} disabled={readonly || busy} onChange={event=>{setName(event.target.value);setDirty(true);}} /></label>
        <fieldset className="agent-choice-field roster-agent-field" disabled={readonly || busy}><legend>参与分配的智能体（至少两个）</legend>{agents.filter(agent=>agent.enabled && agent.hasToken || agentIds.includes(agent.id)).map(agent=><label key={agent.id}><input type="checkbox" checked={agentIds.includes(agent.id)} onChange={event=>{setAgentIds(event.target.checked?[...agentIds,agent.id]:agentIds.filter(id=>id!==agent.id));setDirty(true);}}/><span>{agent.internalName}</span></label>)}</fieldset></div>
      {!readonly && <>
        <p className="profile-hint">默认班内按成绩降序三等分，同分按参与姓名排序，人数不能整除时各层尽量接近。也可整班导入高/中/低层级。同班重名请先改为张三1、张三2。最多 5000 人。</p>
        <div className="roster-actions"><button type="button" className="admin-refresh" onClick={()=>download(new Blob(["\uFEFF"+template],{type:"text/csv;charset=utf-8"}),"名单导入模板.csv")}>下载 CSV 模板</button>
          <label className="admin-refresh roster-import">导入 CSV / TSV<input type="file" accept=".csv,.tsv,.txt" disabled={busy} onChange={async event=>{const file=event.target.files?.[0];if(!file)return;if(file.size>3_000_000){setError("文件过大。");return;}try{setText(await file.text());setImportedFile(file.name);setAdjusted(null);setDirty(true);setError("");}catch{setError("文件读取失败。");}}}/></label>{importedFile && <span className="roster-file-name" title={importedFile}>{importedFile}</span>}</div>
        <label className="roster-source"><span>名单内容（也可粘贴表格，首行需为表头）</span><textarea value={text} placeholder={template} rows={7} disabled={busy} onChange={event=>{setText(event.target.value);setAdjusted(null);setDirty(true);}} /></label>
        <label className="roster-manual"><input type="checkbox" checked={manual} disabled={busy} onChange={event=>{setManual(event.target.checked);setAdjusted(null);setDirty(true);}}/><span>使用导入名单中的人工分配；未勾选时由系统生成</span></label>
        <div className="roster-actions"><button type="button" className="admin-save" disabled={busy || !name.trim() || agentIds.length<2 || !text.trim()} onClick={save}>{busy?"处理中…":adjusted?"保存人工调整并更新预览":"保存草案并预览分配"}</button>
          {selected && <button type="button" className="admin-save" disabled={busy || dirty} onClick={()=>setConfirmation("lock")}>锁定方案并开放入口</button>}</div>
        {dirty && selected && <p className="profile-hint">存在未保存修改，请先保存并核对新的预览，再锁定。</p>}
      </>}
      {selected && <>
        <p className="profile-hint">版本 {selected.version} · {selected.manual?"人工指定分配":"系统生成分配"} · {selected.rule}</p>
        {selected.locked && !selected.entryDeletedAt && <details><summary>补录新学生（保留已有分配）</summary><p className="profile-hint">只新增名单行。必须指定班级、参与姓名、前测成绩、层级及智能体名称或 agentId；不会重新计算原学生层级或分配。补录后请刷新学生入口以加载新班级。</p>
          <label className="roster-source"><span>补录名单</span><textarea rows={5} value={appendText} disabled={busy} onChange={event=>setAppendText(event.target.value)} placeholder={`班级,参与姓名,前测成绩,层级,智能体\n一班,补录学生,75,中,${label(selected.agentIds[0])}`}/></label>
          <button type="button" className="admin-save" disabled={busy || !appendText.trim()} onClick={()=>{try{const students=parseRosterText(appendText).map(row=>({...row,agentId:agents.find(agent=>agent.id===row.agentId || agent.internalName===row.agentId)?.id ?? row.agentId}));if(students.some(row=>!row.stratum || !row.agentId))throw new Error("补录必须指定每名学生的层级和智能体。");setAppendPreview(allocateRoster(students,selected.agentIds,true));setConfirmation("append");}catch(error){setError(error instanceof Error?error.message:"补录名单无效。");}}}>确认补录并更新预览</button></details>}
        {selected.locked && !selected.entryDeletedAt && <div className="run-link-row"><div><strong>名单分层预分配 · {selected.status==="active"?"开放中":"已停止新报名"}</strong><code>/roster/{selected.entryToken}</code></div>
          <button type="button" className="admin-refresh" onClick={async()=>{try{await navigator.clipboard.writeText(`${selected.name}（名单分层预分配）\n${window.location.origin}/roster/${selected.entryToken}`);setStatus("统一入口已复制。");}catch{setError("复制失败，请手动复制链接。");}}}>复制统一入口</button>
          <button type="button" className="admin-refresh" disabled={busy} onClick={()=>void perform({action:selected.status==="active"?"close":"reopen",runId:selected.id})}>{selected.status==="active"?"停止新报名":"继续报名"}</button>
          {selected.status==="closed" && <button type="button" className="admin-danger" disabled={busy} onClick={()=>{setDeleteCode("");setConfirmation("delete");}}>删除链接</button>}</div>}
        <label className="roster-choice"><span>按最终智能体组查看与导出</span><select value={agentFilter} onChange={event=>{setAgentFilter(event.target.value);setPage(0);}}><option value="">全部智能体组</option>{selected.agentIds.map(id=><option key={id} value={id}>{label(id)}</option>)}</select></label>
        <div className="roster-actions"><button type="button" className="admin-refresh" disabled={busy || dirty} onClick={()=>setConfirmation("export")}>导出名单、分配与参与状态</button><button type="button" className="admin-refresh" disabled={busy || dirty} onClick={()=>void perform({action:"interactions_export",runId:selected.id,agentId:agentFilter || undefined})}>导出当前智能体组交互 ZIP</button>
          <button type="button" className="admin-refresh" disabled={busy} onClick={async()=>{try{const response=await fetch(endpoint,{cache:"no-store"});const data=await response.json();if(!response.ok)throw new Error(data.error?.message);setPlans(data.rosters);const plan=(data.rosters as Plan[]).find(plan=>plan.id===selected.id);if(plan)choose(plan);}catch{setError("刷新失败，请重试。");}}}>刷新已保存方案</button></div>
        <h3>已保存的各组前测概况</h3><div className="roster-table-wrap"><table className="roster-table"><thead><tr><th>智能体组</th><th>计划人数</th><th>已进入</th><th>已有完成交互</th><th>均值</th><th>样本标准差</th><th>最低分</th><th>最高分</th></tr></thead><tbody>{selected.statistics.map(stat=><tr key={stat.agentId}><td>{label(stat.agentId)}</td><td>{stat.n}</td><td>{selected.students.filter(row=>row.agentId===stat.agentId && row.participantCode).length}</td><td>{selected.students.filter(row=>row.agentId===stat.agentId && row.hasCompleted).length}</td><td>{number(stat.mean)}</td><td>{number(stat.sd)}</td><td>{number(stat.min)}</td><td>{number(stat.max)}</td></tr>)}</tbody></table></div>
        <h3>班级 × 层级的计划人数{adjusted?"（含未保存调整）":""}</h3><div className="roster-table-wrap"><table className="roster-table"><thead><tr><th>班级</th><th>层级</th>{agentIds.map(id=><th key={id}>{label(id)}</th>)}</tr></thead><tbody>{classes.flatMap(className=>STRATA.map(stratum=><tr key={`${className}-${stratum}`}><td>{className}</td><td>{stratum}</td>{agentIds.map(id=><td key={id}>{students.filter(row=>row.className===className && row.stratum===stratum && row.agentId===id).length}</td>)}</tr>))}</tbody></table></div>
        <p className="profile-hint">各班层级表示班内相对位置。人数接近不代表前测完全一致，请结合实际成绩分布核对。人数不足时可能有空单元格；缺席不会触发重新分配。</p>
        <h3>学生分配明细</h3><div className="roster-table-wrap"><table className="roster-table"><thead><tr><th>班级</th><th>参与姓名</th><th>前测</th><th>层级</th><th>智能体</th><th>被试编号</th></tr></thead><tbody>{filteredStudents.slice(page*100,page*100+100).map((row)=><tr key={JSON.stringify([row.className,row.fullName])}><td>{row.className}</td><td>{row.fullName}</td><td>{row.score}</td><td>{row.stratum}</td><td>{readonly?label(row.agentId):<select value={row.agentId} disabled={busy} onChange={event=>{const updated=[...students];const index=students.findIndex(student=>student.className===row.className && student.fullName===row.fullName);updated[index]={...row,agentId:event.target.value};setAdjusted(updated);setDirty(true);}}>{agentIds.map(id=><option key={id} value={id}>{label(id)}</option>)}</select>}</td><td>{selected.students.find(saved=>saved.className===row.className && saved.fullName===row.fullName)?.participantCode || "未进入"}</td></tr>)}</tbody></table></div>
        {filteredStudents.length>100 && <div className="roster-actions"><button className="admin-refresh" disabled={page===0} onClick={()=>setPage(page-1)}>上一页</button><span>{page+1} / {Math.ceil(filteredStudents.length/100)}</span><button className="admin-refresh" disabled={(page+1)*100>=filteredStudents.length} onClick={()=>setPage(page+1)}>下一页</button></div>}
      </>}
    </>}
    {confirmation && selected && <div className="profile-modal-backdrop"><section className="profile-modal" role="dialog" aria-modal="true" aria-labelledby="roster-confirm-title"><h2 id="roster-confirm-title">{confirmation==="lock"?"确认锁定并开放入口？":confirmation==="append"?"确认补录新学生？":confirmation==="delete"?"确认实验结束并删除链接？":"确认导出名单？"}</h2>
      <p className="profile-hint">{confirmation==="lock"?"锁定后原名单和分配不能覆盖，学生可使用统一入口报名。请确认已核对预览。":confirmation==="append"?`新增 ${appendPreview.length} 人，使用输入的层级与智能体，已有学生分配保持不变。`:confirmation==="delete"?"原链接将失效，研究记录保留。请输入入口码确认。":"文件包含参与姓名、前测成绩及分配结果，请妥善保管。"}</p>
      {confirmation==="append" && <div className="roster-table-wrap"><table className="roster-table"><thead><tr><th>班级</th><th>姓名</th><th>成绩</th><th>层级</th><th>智能体</th></tr></thead><tbody>{appendPreview.slice(0,100).map((row,i)=><tr key={i}><td>{row.className}</td><td>{row.fullName}</td><td>{row.score}</td><td>{row.stratum}</td><td>{label(row.agentId)}</td></tr>)}</tbody></table></div>}
      {confirmation==="delete" && <label className="roster-choice"><span>入口码</span><input value={deleteCode} onChange={event=>setDeleteCode(event.target.value)} autoComplete="off"/></label>}
      {error && <p role="alert" className="directory-error">{error}</p>}
      <div className="roster-actions"><button type="button" className="admin-refresh" disabled={busy} onClick={()=>setConfirmation(null)}>取消</button><button type="button" className={confirmation==="delete"?"admin-danger":"admin-save"} disabled={busy || confirmation==="delete" && deleteCode.trim().toLowerCase()!==selected.entryToken} onClick={()=>void perform(confirmation==="append"?{action:"append",runId:selected.id,version:selected.version,students:appendPreview}:confirmation==="lock"?{action:"lock",runId:selected.id,version:selected.version}:confirmation==="delete"?{action:"delete",runId:selected.id,confirmationCode:deleteCode}:{action:"export",runId:selected.id,agentId:agentFilter || undefined})}>{busy?"处理中…":"确认执行"}</button></div>
    </section></div>}
    {selected?.entryDeletedAt && !active && <button type="button" className="admin-refresh" onClick={()=>{setSelected(null);setText("");setName("名单分层实验");setAdjusted(null);setDirty(false);setAgentIds([]);}}>创建新的名单入口</button>}
  </section>;
}
