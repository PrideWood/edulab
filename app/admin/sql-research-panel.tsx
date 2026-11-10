"use client";
import {useState} from 'react';
import type {SqlControl} from '@/lib/sql-study-policy';
import type {ResearchAssessment} from '@/lib/sql-study-research';
type RecordRow={device_id:string;participant_id:string;participant_name:string;class_code:string;is_test:boolean;archive:{study:unknown}};
type Study={research_version?:string;prior_research_exposure?:boolean;baseline_reused_from_prior_protocol?:boolean;rounds:Array<{id:string;index:number;phase:string;submission?:{sql:string;result:string;note:string;prediction?:{value:number|null;status:string}};mental_effort?:{value:number|null;status:string};dialogue_end?:{reason:string};requests?:Array<{status:string;closing?:boolean}>}>};
type Props={records:RecordRow[];assessments:ResearchAssessment[];config:SqlControl;edit:(fn:(c:SqlControl)=>void)=>void;perform:(body:unknown,message:string)=>Promise<unknown>;busy:boolean;dirty:boolean;classCode:string};
const endpoint='/api/admin/sql-study';
export function SqlResearchPanel({records,assessments,config,edit,perform,busy,dirty,classCode}:Props){
 const [showTests,setShowTests]=useState(false);
 const rows=records.filter(r=>r.class_code===classCode&&(showTests||!r.is_test));
 const dates=config.d1_schedule[classCode]??{t4_date:null,d1_date:null};
 return <><h3>固定研究协议 · {config.research.version}</h3><p>P0起固定L/T；P0最多6轮、正式最多12轮。共同教学徒窗口最后60秒只收尾；窗口结束填写1—9精神努力（可暂不回答），再进入独立实操。首次讲解建议说明目标、方法、理由与核验，不设最低字数。</p>
 <p>前测和实操提交前采集预估分。D1保持纸笔20分钟，T4后第7天、允许±2天；这里记录评分和施测信息，不向学生端显示研究成绩。</p>
 <div className="sql-control-grid"><label>{classCode} · T4日期<input type="date" value={dates.t4_date??''} onChange={e=>edit(c=>{c.d1_schedule[classCode]={...dates,t4_date:e.target.value||null};})}/></label><label>D1计划日期<input type="date" value={dates.d1_date??''} onChange={e=>edit(c=>{c.d1_schedule[classCode]={...dates,d1_date:e.target.value||null};})}/></label></div><p className="profile-hint">日期修改须点击上方“保存并生效”。评分中的实际日期另行记录，超出窗口会标记而非强行删除。</p>
 <p><a href={`${endpoint}?format=d1_student`}>下载D1学生卷 MD</a> | <a href={`${endpoint}?format=d1_teacher`}>下载D1教师答案与评分 MD（勿发学生）</a></p>
 <p><a href={`${endpoint}?format=research`}>导出测量与校准 CSV</a> | <a href={`${endpoint}?format=ena`}>导出ENA对话准备 CSV（假名化）</a> | <a href={`${endpoint}?format=ena&include_tests=1`}>含测试身份的导出预览</a></p>
 <p className="profile-hint">正式导出默认排除测试身份。ENA导出保留角色、原消息顺序、课次、请求状态和收尾/重试标记；不包含截图和姓名列，已知学生姓名会替换。文本仍可能有其他身份线索，公开前人工复核。它是编码输入，不是自动ENA结果。P0与正式课分开标记，不能把消息当独立被试。</p>
 <label><input type="checkbox" checked={showTests} onChange={e=>setShowTests(e.target.checked)}/>显示测试身份</label>
 {rows.map(row=>{const study=row.archive.study as Study;if(study.research_version!==config.research.version)return <p key={row.device_id+row.participant_id}>{row.participant_name}：旧协议，请使用0.10.0重新进入并同步；旧记录保留。</p>;
 return <details key={row.device_id+row.participant_id}><summary>{row.class_code} · {row.participant_name}{row.is_test?'（测试）':''}</summary>
 {(study.prior_research_exposure||study.baseline_reused_from_prior_protocol)&&<p className="directory-error">含旧协议接触或复用基线，须核对正式样本纳入；历史内容保留在完整JSON的research_history。</p>}
 {study.rounds.map(round=><section key={round.id}><h4>{round.index===4?'P0':'T'+(round.index+1)} · 精神努力 {round.mental_effort?.status==='answered'?round.mental_effort.value:round.mental_effort?.status==='skipped'?'暂不回答':'未采集'} · 收束 {round.dialogue_end?.reason??'未结束'}</h4><p>完成轮数：{round.requests?.filter(q=>q.status==='completed'&&!q.closing).length??0}；预估分：{round.submission?.prediction?.status==='answered'?round.submission.prediction.value:round.submission?.prediction?.status==='skipped'?'暂不回答':'未采集'}</p>
 {round.submission&&<><pre>{round.submission.sql}</pre><pre>{round.submission.result}</pre><p>{round.submission.note}</p><AssessmentForm key={round.id+':'+(assessments.find(a=>a.device_id===row.device_id&&a.participant_id===row.participant_id&&a.assessment==='practice'+round.index)?.revision??0)} row={row} kind={'practice'+round.index} roundId={round.id} saved={assessments.find(a=>a.device_id===row.device_id&&a.participant_id===row.participant_id&&a.assessment==='practice'+round.index&&a.protocol_version===config.research.version&&a.payload.round_id===round.id)} dates={dates} perform={perform} disabled={busy||dirty}/></>}
 </section>)}
 <h4>D1纸笔延时后测</h4><AssessmentForm key={'d1:'+(assessments.find(a=>a.device_id===row.device_id&&a.participant_id===row.participant_id&&a.assessment==='d1')?.revision??0)} row={row} kind="d1" saved={assessments.find(a=>a.device_id===row.device_id&&a.participant_id===row.participant_id&&a.assessment==='d1'&&a.protocol_version===config.research.version)} dates={dates} perform={perform} disabled={busy||dirty}/>
 </details>;})}
 {!rows.length&&<p>本班暂无符合当前筛选的云端记录。先使用新版学生端登录并备份，或勾选测试身份进行试运行。</p>}
 {dirty&&<p>请先保存班级/日期/课堂设置，再录入研究评分。</p>}</>;
}
function AssessmentForm({row,kind,roundId,saved,dates,perform,disabled}:{row:RecordRow;kind:string;roundId?:string;saved?:ResearchAssessment;dates:{t4_date:string|null;d1_date:string|null};perform:Props['perform'];disabled:boolean}){
 const p=saved?.payload;const [status,setStatus]=useState(p?.status??'submitted');const isD1=kind==='d1';const limits=isD1?[25,30,25,20]:[30,30,20,20];const labels=isD1?['题1','题2','题3','题4']:['范围条件','查询结构与输出','实际结果交付','核验解释'];
 return <form className="research-grade-form" onSubmit={e=>{e.preventDefault();const f=new FormData(e.currentTarget);const values=(prefix:string)=>limits.map((_,i)=>String(f.get(prefix+i)??'').trim());const final=values('score'),second=values('second');if(status==='submitted'&&final.some(v=>v===''))return;if(second.some(v=>v!=='')&&second.some(v=>v==='')){alert('第二评分者如填写，须填完整四项。');return;}void perform({action:'research_grade',data:{deviceId:row.device_id,participantId:row.participant_id,kind,roundId,revision:saved?.revision??0,status,scores:status==='submitted'?final.map(Number):null,secondScores:status==='submitted'&&second.some(v=>v!=='')?second.map(v=>v===''?NaN:Number(v)):null,testDate:String(f.get('testDate')??'')||null,t4Date:String(f.get('t4Date')??'')||null,predictedScore:status==='submitted'&&f.get('predictedScore')!==null&&f.get('predictedScore')!==''?Number(f.get('predictedScore')):null,predictionStatus:status==='submitted'?String(f.get('predictionStatus')??'not_collected'):'not_collected',notes:String(f.get('notes')??'')}},'研究评分已保存；原始评分与修订审计保留。');}}>
 <label>状态<select value={status} onChange={e=>setStatus(e.target.value)}><option value="submitted">已作答/评分</option><option value="absent">缺席</option><option value="not_collected">未采集</option></select></label>
 {status==='submitted'&&<><div className="sql-control-grid">{limits.map((max,i)=><label key={i}>{labels[i]} · 最终/单评分（0—{max}）<input name={'score'+i} type="number" min={0} max={max} step={0.5} required defaultValue={p?.scores?.[i]??''}/></label>)}</div><details><summary>第二评分者原始分（选填；如填写请填完整四项）</summary><div className="sql-control-grid">{limits.map((max,i)=><label key={i}>{labels[i]} · 第二评分<input name={'second'+i} type="number" min={0} max={max} step={0.5} defaultValue={p?.second_scores?.[i]??''}/></label>)}</div></details></>}
 {p?.first_scores&&<p className="profile-hint">首次保存的评分：{p.first_scores.join(' / ')}；当前总分：{p.total??'缺失'}。每次修订同时保留审计。</p>}
 {isD1&&<div className="sql-control-grid"><label>实际/缺席施测日期<input name="testDate" type="date" required defaultValue={p?.test_date??dates.d1_date??''}/></label><label>T4日期<input name="t4Date" type="date" defaultValue={p?.t4_date??dates.t4_date??''}/></label><label>纸卷预估分状态<select name="predictionStatus" defaultValue={p?.prediction.status??'not_collected'}><option value="not_collected">未采集/缺失</option><option value="answered">已填写</option><option value="skipped">暂不回答</option></select></label><label>纸卷预估分（0—100）<input name="predictedScore" type="number" min={0} max={100} defaultValue={p?.prediction.value??''}/></label></div>}
 {p?.out_of_window&&<p className="directory-error">实际间隔{p.days_after_t4}天，超出5—9天目标窗；保留并在分析时标记。</p>}
 <label>异常、补测或评分说明<textarea name="notes" maxLength={2000} defaultValue={p?.notes??''}/></label><button className="admin-save" disabled={disabled}>保存{isD1?'D1':'实操'}评分</button>
 </form>;
}
