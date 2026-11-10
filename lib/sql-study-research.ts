import 'server-only';
import {createHash,randomUUID} from 'node:crypto';
import {z} from 'zod';
import {query,transaction} from '@/db';
import {ApiError} from '@/lib/http';
import {toCsv,SQL_STUDY,type SqlControl} from './sql-study-policy';
import type {CloudRow} from './sql-study-control';
export const RESEARCH_VERSION='sql-lt/1.1';
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+'T00:00:00Z');return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;},'日期无效');
const scores=z.array(z.number().min(0).max(30)).length(4);
const schema=z.object({deviceId:z.uuid(),participantId:z.uuid(),kind:z.enum(['practice0','practice1','practice2','practice3','practice4','d1']),roundId:z.uuid().optional(),revision:z.number().int().min(0),status:z.enum(['submitted','absent','not_collected']),scores:scores.nullable(),secondScores:scores.nullable().default(null),testDate:day.nullable().default(null),t4Date:day.nullable().default(null),notes:z.string().trim().max(2000).default('')}).superRefine((v,ctx)=>{
 const limits=v.kind==='d1'?[25,30,25,20]:[30,30,20,20];
 for(const key of ['scores','secondScores'] as const){const values=v[key];if(values?.some((n,i)=>n>limits[i]))ctx.addIssue({code:'custom',message:'分项超过满分',path:[key]});}
 if(v.status==='submitted'&&!v.scores)ctx.addIssue({code:'custom',message:'已作答须填写四项分数',path:['scores']});
 if(v.status!=='submitted'&&(v.scores||v.secondScores))ctx.addIssue({code:'custom',message:'缺席或未采集不得记零分',path:['scores']});
 if(v.kind==='d1'&&!v.testDate)ctx.addIssue({code:'custom',message:'请记录延时测实际/计划施测日期',path:['testDate']});
});
export type ResearchPayload={status:string;scores:number[]|null;first_scores:number[]|null;second_scores:number[]|null;total:number|null;prediction?:{value:number|null;status:string;origin?:string};test_date:string|null;t4_date:string|null;days_after_t4:number|null;out_of_window:boolean|null;notes:string;round_id:string|null;grading_version:string;protocol_version:string};
export type ResearchAssessment={device_id:string;participant_id:string;protocol_version:string;assessment:string;revision:number;payload:ResearchPayload;updated_at:string};
export async function getPaperMaterial(kind:'student'|'teacher'){
 const row=(await query<{content:string}>('SELECT content FROM sql_study_paper_materials WHERE id=$1 AND version=$2',[kind,'SQL-LT-D1/v1.1'])).rows[0];
 if(!row)throw new ApiError(404,'PAPER_NOT_CONFIGURED','私有延时材料尚未导入，请联系研究负责人。');return row.content;
}
export async function getResearchAssessments(){return (await query<ResearchAssessment>('SELECT device_id,participant_id,protocol_version,assessment,revision,payload,updated_at FROM sql_study_research_assessments ORDER BY updated_at DESC')).rows;}
export async function saveResearchAssessment(raw:unknown,config:SqlControl,adminId:string){
 const parsed=schema.safeParse(raw);if(!parsed.success)throw new ApiError(400,'INVALID_RESEARCH_GRADE',parsed.error.issues[0]?.message??'请核对评分');const v=parsed.data;
 return transaction(async c=>{
 const person=(await c.query<CloudRow>("SELECT * FROM edulab_local_backup.latest_participants WHERE device_id=$1 AND participant_id=$2 AND archive->>'study_schema'=$3",[v.deviceId,v.participantId,SQL_STUDY])).rows[0];
 if(!person||person.archive.study.research_version!==RESEARCH_VERSION)throw new ApiError(409,'PROTOCOL_NOT_READY','请先用0.13.0学生端进入并同步当前研究协议。');
 const index=v.kind==='d1'?null:Number(v.kind.slice(-1));const round=index===null?null:person.archive.study.rounds.find(r=>r.index===index);
 if(index!==null&&(!round?.submission||round.id!==v.roundId))throw new ApiError(409,'SUBMISSION_CHANGED','实操尚未提交或试测课堂已切换，请刷新后评分。');
 const before=(await c.query<ResearchAssessment>('SELECT * FROM sql_study_research_assessments WHERE device_id=$1 AND participant_id=$2 AND protocol_version=$3 AND assessment=$4 FOR UPDATE',[v.deviceId,v.participantId,RESEARCH_VERSION,v.kind])).rows[0];
 if((before?.revision??0)!==v.revision)throw new ApiError(409,'GRADE_CHANGED','评分已由其他窗口更新，请刷新。');

 const t4=v.t4Date??config.d1_schedule[person.class_code]?.t4_date??null;
 const days=v.testDate&&t4?Math.round((Date.parse(v.testDate+'T00:00:00Z')-Date.parse(t4+'T00:00:00Z'))/86400000):null;
 const payload:ResearchPayload={status:v.status,scores:v.scores,first_scores:before?.payload.round_id===(v.roundId??null)?before.payload.first_scores??v.scores:v.scores,second_scores:v.secondScores,total:v.scores?.reduce((a,b)=>a+b,0)??null,...(before?.payload.prediction?{prediction:before.payload.prediction}:{}),test_date:v.testDate,t4_date:t4,days_after_t4:days,out_of_window:days===null?null:days<5||days>9,notes:v.notes,round_id:v.roundId??null,grading_version:v.kind==='d1'?config.research.d1_version:'practice-rubric/1',protocol_version:RESEARCH_VERSION};
 const row=(await c.query<ResearchAssessment>(`INSERT INTO sql_study_research_assessments(device_id,participant_id,protocol_version,assessment,payload,revision,updated_by) VALUES($1,$2,$3,$4,$5::jsonb,1,$6) ON CONFLICT(device_id,participant_id,protocol_version,assessment) DO UPDATE SET payload=EXCLUDED.payload,revision=sql_study_research_assessments.revision+1,updated_by=EXCLUDED.updated_by,updated_at=now() RETURNING *`,[v.deviceId,v.participantId,RESEARCH_VERSION,v.kind,JSON.stringify(payload),adminId])).rows[0];
 await c.query('INSERT INTO sql_study_audit(id,admin_id,action,payload) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),adminId,'research.grade',JSON.stringify({before:before??null,after:row})]);return {ok:true,assessment:row};
 });
}
const anon=(...values:string[])=>createHash('sha256').update(values.join(':')).digest('hex').slice(0,20);
export function exportEnaMessages(records:CloudRow[],includeTests=false){
 const names=[...new Set(records.map(r=>r.participant_name).filter(n=>n.length>=2))].sort((a,b)=>b.length-a.length);
 const rows:unknown[][]=[['student_id','class_code','group','is_test','prior_exposure','baseline_reused','protocol_version','phase','lesson','round_id','message_id','role','sequence_no','turn_index','sent_at','response_status','response_kind','closing_reply','retry_of','code_eligible','has_image','text']];
 for(const person of records){if(person.is_test&&!includeTests)continue;const p=person.archive.study;if(p.research_version!==RESEARCH_VERSION)continue;for(const raw of p.rounds){
  const r=raw as Record<string,unknown>&{index:number;id:string;research_version?:string;group?:string;messages:Array<{id?:string;role:string;content?:string;sequence_no?:number;turn_index?:number;sent_at?:string;request_id?:string;image?:string}>;requests:Array<{id:string;status:string;closing?:boolean;retry_of?:string;response_kind?:string}>};
  if(r.research_version!==RESEARCH_VERSION)continue;
  const student=anon(RESEARCH_VERSION,person.device_id,person.participant_id);
  for(const [i,m] of r.messages.entries()){const req=r.requests.find(q=>q.id===m.request_id);let text=m.content??'';for(const name of names)text=text.split(name).join('[姓名]');
   rows.push([student,person.class_code,r.group,person.is_test,p.prior_research_exposure??false,p.baseline_reused_from_prior_protocol??false,RESEARCH_VERSION,r.index===4?'preparation':'formal',r.index===4?'P0':'T'+(r.index+1),anon(r.id),anon(r.id,m.id??String(i)),m.role,m.sequence_no??i+1,m.turn_index,m.sent_at,req?.status??'greeting',req?.response_kind??'',req?.closing??false,req?.retry_of?anon(r.id,req.retry_of):'',m.role==='user'&&req?.status==='completed',!!m.image,text]);
  }
 }}return toCsv(rows);
}
export function exportResearchMeasures(records:CloudRow[],assessments:ResearchAssessment[],includeTests=false){
 const rows:unknown[][]=[['student_id','class_code','group','protocol_version','is_test','prior_exposure','baseline_reused','lesson','assessment','status','score','mental_effort_status','mental_effort_1_9','dialogue_end','completed_turns','max_turns','test_date','days_after_t4','out_of_window','measurement_policy','delivery_mode']];
 for(const person of records){if(person.is_test&&!includeTests)continue;const p=person.archive.study;if(p.research_version!==RESEARCH_VERSION)continue;const id=anon(RESEARCH_VERSION,person.device_id,person.participant_id);
 const add=(lesson:string,kind:string,status:unknown,score:unknown,eff?:{status?:string;value?:number|null},end?:unknown,count?:unknown,max?:unknown,date?:unknown,days?:unknown,window?:unknown)=>rows.push([id,person.class_code,p.group,RESEARCH_VERSION,person.is_test,p.prior_research_exposure??false,p.baseline_reused_from_prior_protocol??false,lesson,kind,status,score,eff?.status,eff?.value,end,count,max,date,days,window,p.measurement_policy??'legacy',p.delivery_mode??'legacy']);
 add('','pretest',p.pretest?'submitted':'not_collected',p.pretest?.score);
 for(const r of p.rounds){const grade=assessments.find(a=>a.device_id===person.device_id&&a.participant_id===person.participant_id&&a.protocol_version===RESEARCH_VERSION&&a.assessment==='practice'+r.index&&a.payload.round_id===r.id);const requests=r.requests as Array<{status:string;closing?:boolean}>;const limits=(r.config as {research?:{formal_turns:number;preparation_turns:number}})?.research;
 add(r.index===4?'P0':'T'+(Number(r.index)+1),'practice',grade?.payload.status??(r.submission?'ungraded':'not_submitted'),grade?.payload.total,r.mental_effort as {status?:string;value?:number|null},(r.dialogue_end as {reason?:string})?.reason,requests?.filter(q=>q.status==='completed'&&!q.closing).length,Number(r.index)===4?limits?.preparation_turns:limits?.formal_turns);}
 const d1=assessments.find(a=>a.device_id===person.device_id&&a.participant_id===person.participant_id&&a.protocol_version===RESEARCH_VERSION&&a.assessment==='d1')?.payload;add('D1','d1',d1?.status??'not_collected',d1?.total,undefined,undefined,undefined,undefined,d1?.test_date,d1?.days_after_t4,d1?.out_of_window);
 }return toCsv(rows);
}
