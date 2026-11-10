import { z } from 'zod';
import {saveResearchAssessment,exportEnaMessages,exportResearchMeasures,getPaperMaterial} from '@/lib/sql-study-research';
import {getAuthenticatedAdmin,assertSameOrigin} from '@/lib/admin-auth';
import {ApiError,errorResponse} from '@/lib/http';
import {getSqlDashboard,getSqlControl,saveSqlControl,assignSqlClass,gradeSql,assignSqlTest,selectSqlTestLesson} from '@/lib/sql-study-control';
import {composeSqlPrompt,boundedSqlReply,toCsv,SQL_LESSON_ORDER,sqlLessonLabel,sqlRoundLabel,sqlRoundPhase,sqlRecordOrder,SQL_PREPARATION_LESSON} from '@/lib/sql-study-policy';
import {getSharedModelConnection,getSharedModelSummary} from '@/lib/shared-model';
import {runDeepSeekChat,DeepSeekError} from '@/lib/deepseek';
export const runtime='nodejs';export const maxDuration=120;
const headers={'Cache-Control':'private, no-store'};
const input=z.discriminatedUnion('action',[
 z.object({action:z.literal('research_grade'),data:z.unknown()}),
 z.object({action:z.literal('save'),revision:z.number().int().positive(),config:z.unknown()}),
 z.object({action:z.literal('select_test_lesson'),deviceId:z.uuid(),participantId:z.uuid(),lesson:z.number().int().min(0).max(4)}),
 z.object({action:z.literal('assign_test'),classCode:z.string(),name:z.string().trim().min(1).max(100),group:z.enum(['L','T'])}),
 z.object({action:z.literal('assign'),classCode:z.string(),includeTests:z.boolean().default(false)}),
 z.object({action:z.literal('grade'),deviceId:z.uuid(),participantId:z.uuid(),lesson:z.number().int().min(0).max(4),scores:z.array(z.number().min(0).max(20)).length(2)}),
 z.object({action:z.literal('debug'),lesson:z.number().int().min(0).max(4),text:z.string().trim().min(1).max(4000)})
]);
export async function GET(request:Request){try{
 if(!await getAuthenticatedAdmin())throw new ApiError(401,'ADMIN_REQUIRED','请先登录EduLab管理后台。');
 const formatRequested=new URL(request.url).searchParams.get('format');
 if(formatRequested==='d1_student'||formatRequested==='d1_teacher')return new Response(await getPaperMaterial(formatRequested==='d1_student'?'student':'teacher'),{headers:{...headers,'Content-Type':'text/markdown; charset=utf-8','Content-Disposition':`attachment; filename="SQL-D1-${formatRequested==='d1_student'?'student':'teacher'}.md"`}});
 const data=await getSqlDashboard();const format=new URL(request.url).searchParams.get('format');
 if(format==='ena')return csv(exportEnaMessages(data.records,new URL(request.url).searchParams.get('include_tests')==='1'),'SQL-ENA-messages-pseudonymized.csv');
 if(format==='research')return csv(exportResearchMeasures(data.records,data.researchAssessments,new URL(request.url).searchParams.get('include_tests')==='1'),'SQL-research-measures.csv');
 if(format==='full')return new Response(JSON.stringify({study:'sql-teachable-mvp/1',exported_at:new Date().toISOString(),...data},null,2),{headers:{...headers,'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="SQL-study-complete.json"'}});
 if(format==='posttests'){
  const rows:unknown[][]=[['设备编号','学生UUID','班级','姓名','测试身份','课次','研究阶段','状态','题型','版本','题数','答对数','选择题得分','满分','用时秒',...Array.from({length:10},(_,i)=>`Q${i+1}`),'题目快照JSON']];
  for(const record of data.records)for(const i of sqlRecordOrder(record.archive.study)){
   const round=record.archive.study.rounds.find(r=>r.index===i);
   const q=round?.quiz as {format?:string;version?:string;status?:string;answers?:string[];correct?:number;question_count?:number;mcq_score?:number;max_score?:number;elapsed_seconds?:number;items?:unknown[]}|undefined;
   rows.push([record.device_id,record.participant_id,record.class_code,record.participant_name,record.is_test?'是':'否',round?sqlRoundLabel({index:i,...round}):sqlLessonLabel(i),round?sqlRoundPhase({index:i,...round}):i===SQL_PREPARATION_LESSON?'准备阶段（流程练习）':'正式干预',q?.status??'未提交',q?.format??(q?'历史混合题':''),q?.version,q?.question_count??q?.answers?.length,q?.correct,q?.mcq_score,q?(q.max_score??60):'',q?.elapsed_seconds,...Array.from({length:10},(_,j)=>q?.answers?.[j]),q?.items?JSON.stringify(q.items):'']);
  }
  return csv(toCsv(rows),'SQL-posttests.csv');
 }
 if(format==='questionnaire'||format==='combined'||format==='pretest'){
  const ids=['M01','M02','M03','M04','M05','M06','M07','E01','E02','E03','E04','E05','E06'];
  const identityHeaders=['研究记录键','设备编号','学生UUID','班级','姓名','测试身份','同班同名多档案需核对','组别','备份接收UTC','方案版本','存在旧方案接触','复用历史基线'];
  const metaHeaders=['状态','版本','开始UTC','提交UTC','用时秒',...ids,'理解监控均分','评价均分','题目快照JSON','指导语','选项JSON'];
  const iso=(v:unknown)=>typeof v==='number'?new Date(v*1000).toISOString():'';
  const meta=(value:unknown)=>{const q=value as {answers?:number[];version?:string;started_epoch?:number;finished_epoch?:number;at?:string;elapsed_seconds?:number;monitoring?:number;evaluation?:number;items?:string[];instruction?:string;options?:string[]}|null;
   return [q?'已提交':'未提交',q?.version??(q?'历史版本未记录':''),iso(q?.started_epoch),iso(q?.finished_epoch)||q?.at,q?.elapsed_seconds,...ids.map((_,i)=>q?.answers?.[i]),q?.monitoring,q?.evaluation,q?.items?JSON.stringify(q.items):'',q?.instruction,q?.options?JSON.stringify(q.options):''];};
  const preHeaders=['前测状态','前测得分','前测开始UTC','前测提交UTC','前测用时秒',...Array.from({length:20},(_,i)=>`P${i+1}`)];
  const rows:unknown[][]=[format==='questionnaire'?[...identityHeaders,'时点',...metaHeaders]:format==='pretest'?[...identityHeaders,...preHeaders]:[...identityHeaders,...preHeaders,...metaHeaders.map(h=>'课前_'+h),...metaHeaders.map(h=>'课后_'+h),...SQL_LESSON_ORDER.map(i=>['研究阶段','课堂状态','实操用时秒','实操状态','选择题得分','SQL题1得分','SQL题2得分','后测总分','轮次完整JSON'].map(h=>`${sqlLessonLabel(i)}_${h}`)).flat()]];
  for(const r of data.records){const p=r.archive.study;
   if(p.id!==r.participant_id||r.archive.participant.id!==r.participant_id)throw new ApiError(409,'EXPORT_ID_MISMATCH','备份身份不一致，请核对后导出。');
   const group=data.assignments.find(a=>a.class_code===r.class_code&&a.participant_name===r.participant_name)?.group_code??p.group;
   const identity=[`${r.device_id}:${r.participant_id}`,r.device_id,r.participant_id,r.class_code,r.participant_name,r.is_test?'是':'否',data.records.filter(x=>x.class_code===r.class_code&&x.participant_name===r.participant_name).length>1?'是':'否',group,r.received_at,p.scheme_version??'legacy',p.prior_scheme_exposure?'是':'否',p.baseline_reused_from_legacy?'是':'否'];
   if(format==='questionnaire'){for(const key of ['meta_pre','meta_post'])rows.push([...identity,key,...meta(p[key])]);continue;}
   const pre=p.pretest as {answers?:string[];score:number;started_epoch?:number;finished_epoch?:number;submitted_at?:string;elapsed_seconds?:number}|null;
   const preValues=[pre?'已提交':'未提交',pre?.score,iso(pre?.started_epoch),iso(pre?.finished_epoch)||pre?.submitted_at,pre?.elapsed_seconds,...Array.from({length:20},(_,i)=>pre?.answers?.[i])];
   if(format==='pretest'){rows.push([...identity,...preValues]);continue;}
   const rounds=SQL_LESSON_ORDER.map(i=>{const round=p.scheme_version==='business-workorders/1'?p.rounds.find(r=>r.index===i):undefined;const submission=round?.submission as {elapsed_seconds?:number;status?:string}|undefined;const quiz=round?.quiz as {format?:string;mcq_score?:number;score?:number;sql_scores?:number[]}|undefined;
    const scores=quiz?.format==='single_choice'?undefined:data.grades.find(g=>g.device_id===r.device_id&&g.participant_id===r.participant_id&&g.lesson===i)?.scores??quiz?.sql_scores;
    const total=quiz&&scores&&typeof quiz.mcq_score==='number'?quiz.mcq_score+scores.reduce((a:number,b:number)=>a+b,0):quiz?.score;
    return [round?sqlRoundPhase({index:i,...round}):i===SQL_PREPARATION_LESSON?'准备阶段（流程练习）':'正式第'+(i+1)+'轮',round?.phase,submission?.elapsed_seconds,submission?.status,quiz?.mcq_score,scores?.[0],scores?.[1],total,round?JSON.stringify(round):''];}).flat();
   rows.push([...identity,...preValues,...meta(p.meta_pre),...meta(p.meta_post),...rounds]);
  }
  return csv(toCsv(rows),`SQL-${format}.csv`);
 }
 if(format==='groups')return csv(toCsv([['内部编号','班级','姓名','前测分数','智能体组','配对编号','分组批次','方法'],...data.records.map(r=>{const a=data.assignments.find(a=>a.class_code===r.class_code&&a.participant_name===r.participant_name);const old=r.archive.study.assignment as {pair?:number;batch?:string;method?:string}|undefined;return [r.participant_id,r.class_code,r.participant_name,r.archive.study.pretest?.score,a?.group_code??r.archive.study.group,a?.pair_no??old?.pair,a?.batch_id??old?.batch,a?.method??old?.method];}),[],['班级','组别','人数','前测均分','前测标准差'],...data.balance.map(b=>[b.class_code,b.group,b.n,b.mean,b.sd])]),'SQL-groups.csv');
 if(format==='timings'){
  const rows:unknown[][]=[['内部编号','班级','姓名','组别','课次','阶段','开始UTC','结束UTC','用时秒','状态','研究阶段']];
  const iso=(v:unknown)=>typeof v==='number'?new Date(v*1000).toISOString():'';
  for(const r of data.records){const p=r.archive.study;const group=data.assignments.find(a=>a.class_code===r.class_code&&a.participant_name===r.participant_name)?.group_code??p.group;
   const add=(lesson:unknown,stage:string,start:unknown,end:unknown,elapsed:unknown,status:unknown,phase='测量')=>rows.push([r.participant_id,r.class_code,r.participant_name,group,lesson,stage,iso(start),iso(end),elapsed,status,phase]);
   for(const [key,label] of [['pretest','基础前测'],['meta_pre','课前问卷'],['meta_post','课后问卷']]){const q=p[key] as {started_epoch?:number;finished_epoch?:number;elapsed_seconds?:number}|null;if(q)add('',label,q.started_epoch,q.finished_epoch,q.elapsed_seconds,'submitted');}
   for(const r of p.rounds){const typed={index:Number(r.index),...r};const label=sqlRoundLabel(typed),phase=sqlRoundPhase(typed);
    const start=typeof r.teaching_start==='number'?r.teaching_start:undefined;
    if(start!==undefined){const end=typeof r.teaching_end==='number'?r.teaching_end:undefined;add(label,'AI教学时段',start,end,end===undefined?undefined:end-start,end===undefined?'进行中':'已结束',phase);}
    const submission=r.submission as {elapsed_seconds:number;status:string}|null;
    if(submission)add(label,'独立实操',r.practice_start,Number(r.practice_start)+submission.elapsed_seconds,submission.elapsed_seconds,submission.status,phase);
    const q=r.quiz as {elapsed_seconds?:number;finished_epoch?:number;at?:string;status:string}|null;
    if(q){const finish=q.finished_epoch??(q.at?new Date(q.at).getTime()/1000:undefined);add(label,'当课测评',r.quiz_start,finish,q.elapsed_seconds,q.status,phase);}}

  }return csv(toCsv(rows),'SQL-stage-times.csv');}
 return Response.json({...data,model:await getSharedModelSummary()},{headers});
}catch(e){return errorResponse(e);}}
function csv(text:string,name:string){return new Response(text,{headers:{...headers,'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="${name}"`}});}
export async function POST(request:Request){try{
 assertSameOrigin(request);const admin=await getAuthenticatedAdmin();if(!admin)throw new ApiError(401,'ADMIN_REQUIRED','请先登录EduLab管理后台。');
 const parsed=input.safeParse(await request.json());if(!parsed.success)throw new ApiError(400,'INVALID_SQL_ACTION','请检查课堂设置或作答评分。');const body=parsed.data;
 if(body.action==='research_grade')return Response.json(await saveResearchAssessment(body.data,(await getSqlControl()).config,admin.id),{headers});
 if(body.action==='save')return Response.json(await saveSqlControl(body.config,body.revision,admin.id),{headers});
 if(body.action==='assign')return Response.json(await assignSqlClass(body.classCode,body.includeTests,admin.id),{headers});
 if(body.action==='select_test_lesson')return Response.json(await selectSqlTestLesson(body,admin.id),{headers});
 if(body.action==='assign_test')return Response.json(await assignSqlTest(body.classCode,body.name,body.group,admin.id),{headers});
 if(body.action==='grade')return Response.json(await gradeSql(body,admin.id),{headers});
 const {config}=await getSqlControl();const shared=config.mode==='real'?await getSharedModelConnection():null;
 const results=await Promise.all((['L','T'] as const).map(async group=>{
  if(!shared)return {group,reply:'演示学徒：'+config.research_questions[body.lesson][group==='L'?1:0],source:'demo',reason:group==='L'?'演示规则：按解释选问':'演示规则：按固定检查点推进'};
  try{const reply=await runDeepSeekChat({token:shared.token,baseUrl:shared.baseUrl,directModel:{...shared.config,thinking:false,maxTokens:1600,systemPrompt:''},messages:[{role:'system',content:composeSqlPrompt(config,body.lesson,group)},{role:'user',content:body.text}],jsonOutput:true,signal:AbortSignal.timeout(75000)});
   const result=JSON.parse(reply.answer);if(typeof result.reply!=='string'||!Number.isInteger(result.target)||result.target<0||result.target>5)throw Error('invalid');return {group,...result,target:group==='T'?0:result.target,reply:boundedSqlReply(config,body.lesson,group,1,result),source:'deepseek'};
  }catch(e){return {group,error:e instanceof DeepSeekError?e.message:'回复结构不完整或连接超时。'};}
 }));return Response.json({results,version:config.prompt_version,mode:config.mode},{headers});
}catch(e){return errorResponse(e);}}
