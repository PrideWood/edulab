import { randomInt } from 'node:crypto';
import { z } from 'zod';
export const SQL_CLASSES = ['2531','2532'] as const;
import {SQL_LESSON_ORDER,sqlLessonLabel} from './sql-study-display';
export {SQL_LESSON_ORDER,sqlLessonNumber,sqlLessonLabel,sqlRoundLabel,sqlRoundPhase,sqlRecordOrder,SQL_SCHEME_VERSION,SQL_PREPARATION_LESSON} from './sql-study-display';
export const SQL_STUDY = 'sql-teachable-mvp/1';
const text=z.string().trim().min(1).max(15000);
const dateOnly=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;},'日期无效');
const rule=z.object({mode:z.enum(['closed','open','scheduled','auto']),open_at:z.number().positive().nullable(),close_at:z.number().positive().nullable()}).refine(r=>r.mode!=='scheduled'||r.open_at!==null,'定时开放需要开始时间').refine(r=>!r.close_at||!r.open_at||r.close_at>r.open_at,'截止须晚于开放');
export const controlSchema=z.object({
 dialogue_policy:z.literal('min10-advisory/1').default('min10-advisory/1'),timing_policy:z.literal('advisory/1').default('advisory/1'),
 measurement_policy:z.literal('required-no-prediction/1').default('required-no-prediction/1'),
 access_policy:z.literal('current-task/1').default('current-task/1'),current_lessons:z.record(z.string(),z.number().int().min(0).max(4)).default({}),test_cleanup_epoch:z.string().default('sql-clean-20261110-01'),
 research:z.object({version:z.literal('sql-lt/1.1'),minimum_turns:z.literal(10),dialogue_policy:z.literal('min10-advisory/1'),preparation_grouped:z.literal(true),effort_version:z.literal('mental-effort-sql/1'),d1_version:z.literal('SQL-LT-D1/v1.1'),d1_delay_days:z.literal(7),d1_window_days:z.literal(2)}),
 research_questions:z.array(z.array(text)).length(5).superRefine((qs,ctx)=>{qs.forEach((q,i)=>{if(q.length<10)ctx.addIssue({code:'custom',message:'每课至少10项固定核对问题',path:[i]});});}),
 d1_schedule:z.record(z.string(),z.object({t4_date:dateOnly.nullable(),d1_date:dateOnly.nullable()})).default({}),
 classes_version:z.literal(1),
 classes:z.array(z.object({code:z.string().regex(/^[\p{L}\p{N}_-]{1,30}$/u).refine(c=>!['__proto__','prototype','constructor'].includes(c)),label:z.string().trim().min(1).max(60),planned_size:z.number().int().min(0).max(10000).nullable(),enabled:z.boolean()})).min(1).max(100),
 scheme_version:z.literal('business-workorders/1'),dataset_version:z.literal('script-sql-20261110'),
 sequence_policy:z.literal('teaching-practice-quiz'),
 preparation_timing:z.object({demonstration_minutes:z.number().int().min(1),reading_minutes:z.number().int().min(1),reflection_minutes:z.number().int().min(1),baseline_minutes:z.number().int().min(1),teaching_seconds:z.number().int().min(60).multipleOf(60),practice_seconds:z.number().int().min(60).multipleOf(60),quiz_seconds:z.number().int().min(60).multipleOf(60)}),
 demonstration_minutes:z.number().int().min(1),reading_minutes:z.number().int().min(1),reflection_minutes:z.number().int().min(1),
 teaching_seconds:z.number().int().min(60).multipleOf(60),practice_seconds:z.number().int().min(60).multipleOf(60),quiz_seconds:z.number().int().min(60).multipleOf(60),
 max_questions:z.literal(0).default(0),mode:z.enum(['demo','real']),backup_enabled:z.literal(true),prompt_version:z.number().int().positive(),
 tasks:z.array(z.object({id:text,title:text,pages:text,brief:text,points:z.array(text).length(6),checks:z.array(text).length(6)})).length(5),
 prompts:z.object({common:text,preparation:text.default('准备课执行已分配的L/T策略，范围限于选列、来源、行列含义和提交流程，不提供SQL答案。'),policies:z.object({L:text,T:text}),lessons:z.array(text).length(5)}),
 schedules:z.record(z.string(),z.record(z.string(),rule))
}).superRefine((v,ctx)=>{if(new Set(v.classes.map(c=>c.code)).size!==v.classes.length)ctx.addIssue({code:'custom',message:'班级编号不能重复',path:['classes']});if(!v.classes.some(c=>c.enabled))ctx.addIssue({code:'custom',message:'至少保留一个启用班级',path:['classes']});for(const [i,id] of ['T1','T2','T3','T4','P0'].entries())if(v.tasks[i].id!==id)ctx.addIssue({code:'custom',message:'任务编号必须保持T1、T2、T3、T4、P0，避免错配历史课次',path:['tasks',i,'id']});for(const [cls,rules] of Object.entries(v.schedules))for(const [key,r] of Object.entries(rules))if(r.mode==='auto'&&!/^practice[0-4]$/.test(key))ctx.addIssue({code:'custom',message:'自动解锁仅适用于独立实操',path:['schedules',cls,key]});for(const cls of v.classes.filter(c=>c.enabled).map(c=>c.code)){const schedule=v.schedules[cls];for(const k of ['pretest','meta_pre','meta_post',...Array.from({length:5},(_,i)=>['ai','practice','posttest'].map(s=>s+i)).flat()])if(!schedule?.[k])ctx.addIssue({code:'custom',message:'缺少班级或课堂入口安排',path:['schedules',cls,k]});}});
export type SqlControl = z.infer<typeof controlSchema>;
export function activeSqlClasses(c:SqlControl){return c.classes.filter(x=>x.enabled).map(x=>x.code);}
export type Candidate = {name:string;score:number};
export function groupStats(scores:number[]){const n=scores.length;const mean=n?scores.reduce((a,b)=>a+b,0)/n:null;return {n,mean,sd:n>1?Math.sqrt(scores.reduce((s,x)=>s+(x-mean!)**2,0)/(n-1)):null};}
function shuffle<T>(a:T[],pick:(max:number)=>number){for(let i=a.length-1;i>0;i--){const j=pick(i+1);[a[i],a[j]]=[a[j],a[i]];}return a;}
export function matchedAssignment(people:Candidate[],pick:(max:number)=>number=randomInt){
 const members=shuffle([...people],pick).sort((a,b)=>b.score-a.score);if(members.length<2)throw Error('每个班级至少两人完成前测。');
 let best:{loss:number;groups:('L'|'T')[]}|undefined;
 for(let trial=0;trial<1500;trial++){
  const groups:('L'|'T')[]=[];for(let i=0;i<members.length;i+=2){const pair:('L'|'T')[]=pick(2)?['L','T']:['T','L'];groups.push(...pair.slice(0,members.length-i));}
  const l=groupStats(members.filter((_,i)=>groups[i]==='L').map(x=>x.score)),t=groupStats(members.filter((_,i)=>groups[i]==='T').map(x=>x.score));
  const loss=Math.abs(l.mean!-t.mean!)+Math.abs((l.sd??0)-(t.sd??0));if(!best||loss<best.loss)best={loss,groups};
 }
 return members.map((p,i)=>({...p,group:best!.groups[i],pair:Math.floor(i/2)+1}));
}
export function composeSqlPrompt(c:SqlControl,lesson:number,group:'L'|'T',turn=1){const bank=c.research_questions[lesson],target=(turn-1)%6;return c.prompts.common+'\n组别策略：'+c.prompts.policies[group]+(group==='T'?` 本次下一问target必须为${target}；固定内容：${bank[(turn-1)%bank.length]}。`:'')+'\n当课范围：'+c.prompts.lessons[lesson]+(lesson===4?'\n准备课范围：'+c.prompts.preparation:'')+'\n有限问题范围：'+JSON.stringify(bank)+'\n任务及检查点：'+JSON.stringify(c.tasks[lesson])+'；已有状态：{}';}
export function boundedSqlReply(c:SqlControl,lesson:number,group:'L'|'T',turn:number,result:{reply:string;knowledge?:Record<string,unknown>}){
 const complete=Array.from({length:6},(_,i)=>result.knowledge?.[String(i)]).every(v=>typeof v==='object'&&v!==null&&(v as {status?:string}).status==='explained');
 if(complete&&turn>=10)return '这些讲解已经记录。可以继续补充尚未说明的内容，或结束对话并整理核对表。';
 return group==='T'?c.research_questions[lesson][(turn-1)%c.research_questions[lesson].length]:result.reply;
}
export function csvCell(v:unknown){let s=String(v??'');if(/^[=+@\-\t\r]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function toCsv(rows:unknown[][]){return '\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');}

export function summarizeSqlChanges(old:SqlControl|undefined,next:SqlControl){
 if(!old)return ['初始课堂配置'];const changes:string[]=[];
 const timing=[['demonstration_minutes','共同微课',1],['teaching_seconds','AI教学',60],['practice_seconds','独立实操',60],['quiz_seconds','后测',60]] as const;
 for(const [key,label,unit] of timing)if(old[key]!==next[key])changes.push(`${label}：${(old[key]??40)/unit}→${next[key]/unit}分钟`);
 if(old.mode!==next.mode)changes.push(`学徒模式：${next.mode==='real'?'DeepSeek真实模型':'演示规则'}`);
 if(JSON.stringify(old.preparation_timing)!==JSON.stringify(next.preparation_timing))changes.push('调整准备课各阶段时长');
 if(JSON.stringify(old.research)!==JSON.stringify(next.research))changes.push('更新至少10轮、无上限与建议计时协议');
 if(JSON.stringify(old.research_questions)!==JSON.stringify(next.research_questions))changes.push('更新有限问题序列');
 if(JSON.stringify(old.d1_schedule)!==JSON.stringify(next.d1_schedule))changes.push('更新纸笔延时后测安排');
 if(old.prompts.preparation!==next.prompts.preparation)changes.push('更新准备课共同学徒规则');
 if(old.prompts.common!==next.prompts.common)changes.push('更新通用学徒规则与表达方式');
 for(const g of ['L','T'] as const)if(old.prompts.policies[g]!==next.prompts.policies[g])changes.push(`更新${g}组推进策略`);
 for(const i of SQL_LESSON_ORDER){
  const before=old.tasks[i],after=next.tasks[i];
  if(!before&&!after)continue;
  const label=sqlLessonLabel(i);
  if(!before){changes.push(`新增${label}：${after.title}`);continue;}
  if(!after){changes.push(`移除${label}：${before.title}`);continue;}
  if(old.prompts.lessons[i]!==next.prompts.lessons[i])changes.push(`${label}教学范围`);
  if(before.title!==after.title||before.brief!==after.brief)changes.push(`${label}名称或实操题干`);
  if(JSON.stringify(before.checks)!==JSON.stringify(after.checks)||JSON.stringify(before.points)!==JSON.stringify(after.points))changes.push(`${label}检查点`);
 }
 if(JSON.stringify(old.classes)!==JSON.stringify(next.classes))changes.push('更新班级列表、启用状态或预计人数');
 for(const cls of Object.keys(next.schedules)){const keys=Object.keys(next.schedules[cls]).filter(k=>JSON.stringify(old.schedules[cls]?.[k])!==JSON.stringify(next.schedules[cls][k]));if(keys.length)changes.push(`${cls}：调整${keys.map(k=>k==='pretest'?'基础前测':k==='meta_pre'?'课前问卷':k==='meta_post'?'课后问卷':` ${sqlLessonLabel(Number(k.at(-1)))}${k.startsWith('ai')?'AI':k.startsWith('practice')?'实操':'后测'}`).join('、')}开放安排`);}
 return changes.length>8?[...changes.slice(0,8),`另有${changes.length-8}项更新`]:changes.length?changes:['保存配置，内容未变'];
}
