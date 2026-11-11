import {createHash} from 'node:crypto';
import {toCsv} from '../lib/sql-study-policy';
import type {CloudRow} from '../lib/sql-study-control';
import type {ResearchAssessment} from '../lib/sql-study-research';
const RESEARCH_VERSION='sql-lt/1.1';
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
