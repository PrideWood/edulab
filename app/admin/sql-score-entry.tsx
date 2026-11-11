"use client";
import {useState} from 'react';
import type {ResearchAssessment} from '@/lib/sql-study-research';
type RecordRow={device_id:string;participant_id:string};
export function SqlScoreEntry({row,kind,roundId,saved,dates,perform,disabled}:{row:RecordRow;kind:string;roundId?:string;saved?:ResearchAssessment;dates:{t4_date:string|null;d1_date:string|null};perform:(body:unknown,message:string)=>Promise<unknown>;disabled:boolean}){
 const p=saved?.payload;const [status,setStatus]=useState(p?.status??'submitted');const isD1=kind==='d1';const limits=isD1?[25,30,25,20]:[30,30,20,20];const labels=isD1?['题1','题2','题3','题4']:['范围条件','查询结构与输出','实际结果交付','核验解释'];
 return <form className="research-grade-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);const values=(prefix:string)=>limits.map((_,i)=>String(f.get(prefix+i)??'').trim());const final=values('score'),second=values('second');if(status==='submitted'&&final.some(v=>v===''))return;if(second.some(v=>v!=='')&&second.some(v=>v==='')){alert('第二评分者如填写，须填完整四项。');return;}void perform({action:'research_grade',data:{deviceId:row.device_id,participantId:row.participant_id,kind,roundId,revision:saved?.revision??0,status,scores:status==='submitted'?final.map(Number):null,secondScores:status==='submitted'&&second.some(v=>v!=='')?second.map(v=>v===''?NaN:Number(v)):null,testDate:String(f.get('testDate')??'')||null,t4Date:String(f.get('t4Date')??'')||null,notes:String(f.get('notes')??'')}},'评分已保存；首次评分和修订记录保留。');}}>
 <label>状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="submitted">已作答/评分</option><option value="absent">缺席</option><option value="not_collected">未采集</option></select></label>
 {status==='submitted'&&<><div className="sql-control-grid">{limits.map((max,i)=><label key={i}>{labels[i]} · 最终/单评分（0—{max}）<input name={'score'+i} type="number" min={0} max={max} step={0.5} required defaultValue={p?.scores?.[i]??''}/></label>)}</div><details><summary>第二评分者原始分（选填；如填写请填完整四项）</summary><div className="sql-control-grid">{limits.map((max,i)=><label key={i}>{labels[i]} · 第二评分<input name={'second'+i} type="number" min={0} max={max} step={0.5} defaultValue={p?.second_scores?.[i]??''}/></label>)}</div></details></>}
 {p?.first_scores&&<p className="profile-hint">首次保存的评分：{p.first_scores.join(' / ')}；当前总分：{p.total??'缺失'}。每次修订同时保留审计。</p>}
 {isD1&&<div className="sql-control-grid"><label>实际/缺席施测日期<input name="testDate" type="date" required defaultValue={p?.test_date??dates.d1_date??''}/></label><label>T4日期<input name="t4Date" type="date" defaultValue={p?.t4_date??dates.t4_date??''}/></label></div>}
 {p?.out_of_window&&<p className="directory-error">实际间隔{p.days_after_t4}天，超出5—9天目标窗；记录已保留，请核对实际施测日期。</p>}
 <label>异常、补测或评分说明<textarea name="notes" maxLength={2000} defaultValue={p?.notes??''}/></label><button className="admin-save" disabled={disabled}>保存{isD1?'D1':'实操'}评分</button>
 </form>;
}
