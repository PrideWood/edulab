import 'server-only';
import { randomUUID } from 'node:crypto';
import { query,transaction } from '@/db';
import { ApiError } from '@/lib/http';
import defaults from './sql-study-defaults.json';
import {SQL_STUDY,SQL_CLASSES,controlSchema,matchedAssignment,groupStats,summarizeSqlChanges,type SqlControl} from './sql-study-policy';
export interface CloudArchive {participant:{id:string;name:string;class_code:string};study:{id:string;group:'L'|'T'|null;pretest:{score:number}|null;rounds:Array<Record<string,unknown>>;[key:string]:unknown};[key:string]:unknown}
export type CloudRow = {device_id:string;participant_id:string;participant_name:string;class_code:string;is_test:boolean;received_at:string;archive:CloudArchive};
export function upgradeSqlControl(config:SqlControl):SqlControl {
 const next=structuredClone(config);
 next.preparation_timing??=structuredClone(defaults.preparation_timing);
 next.prompts.preparation??=defaults.prompts.preparation;
 if(next.tasks.length===3){
  next.tasks.push(structuredClone(defaults.tasks[3]));
  next.prompts.lessons.push(defaults.prompts.lessons[3]);
  for(const rules of Object.values(next.schedules))for(const stage of ['ai','practice','posttest'])rules[stage+'3']={mode:stage==='practice'?'auto':'closed',open_at:null,close_at:null};
 }
 for(let i=0;i<3;i++){
  if(next.tasks[i].brief.startsWith('试运行'))next.tasks[i]=structuredClone(defaults.tasks[i]);
  if(next.prompts.lessons[i].startsWith('试运行'))next.prompts.lessons[i]=defaults.prompts.lessons[i];
 }
 return next;
}
export async function getSqlControl(){
 await query('INSERT INTO sql_study_control(id,config) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[SQL_STUDY,JSON.stringify(defaults)]);
 const row=(await query<{revision:number;config:SqlControl;updated_at:string}>('SELECT revision,config,updated_at FROM sql_study_control WHERE id=$1',[SQL_STUDY])).rows[0];
 return {...row,config:upgradeSqlControl(row.config)};
}
export async function saveSqlControl(config:unknown,revision:number,adminId:string){
 const parsed=controlSchema.safeParse(config);if(!parsed.success)throw new ApiError(400,'INVALID_SQL_CONTROL','请检查课堂安排：分钟需为整数、总时长不超过80分钟；云备份必须启用，自动解锁仅适用于实操。');
 return transaction(async c=>{
 const old=(await c.query<{revision:number;config:SqlControl}>('SELECT revision,config FROM sql_study_control WHERE id=$1 FOR UPDATE',[SQL_STUDY])).rows[0];
 if(!old||old.revision!==revision)throw new ApiError(409,'CONTROL_CHANGED','设置已由其他窗口更新，请刷新后再保存。');
 old.config=upgradeSqlControl(old.config);
 const next=parsed.data;next.prompt_version=old.config.prompt_version+(JSON.stringify(old.config.prompts)!==JSON.stringify(next.prompts)||JSON.stringify(old.config.tasks)!==JSON.stringify(next.tasks)?1:0);
 await c.query('UPDATE sql_study_control SET config=$2::jsonb,revision=revision+1,updated_by=$3,updated_at=now() WHERE id=$1',[SQL_STUDY,JSON.stringify(next),adminId]);
 const summary=summarizeSqlChanges(old.config,next);
 const version=(await c.query<SqlVersion>('INSERT INTO sql_study_versions(revision,prompt_version,config,updated_at,summary,created_by) VALUES($1,$2,$3::jsonb,now(),$4::jsonb,$5) RETURNING revision,prompt_version,updated_at,summary',[revision+1,next.prompt_version,JSON.stringify(next),JSON.stringify(summary),adminId])).rows[0];
 await c.query('INSERT INTO sql_study_audit(id,admin_id,action,payload) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),adminId,'control.save',JSON.stringify({before:old,after:next,summary})]);
 return {revision:revision+1,config:next,version};});
}
export async function sqlRoster(){return (await query<CloudRow>(`SELECT p.device_id,p.participant_id,p.participant_name,p.class_code,p.is_test,p.received_at,p.archive FROM edulab_local_backup.latest_participants p
 WHERE archive->>'study_schema'=$1 AND NOT EXISTS(SELECT 1 FROM local_backup_dispositions d WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed)
 ORDER BY p.class_code,p.participant_name,p.received_at DESC LIMIT 2000`,[SQL_STUDY])).rows;}
export async function getSqlAssignments(){return (await query<{class_code:string;participant_name:string;group_code:'L'|'T';pretest_score:string;pair_no:number|null;batch_id:string;method:string}>('SELECT * FROM sql_study_assignments ORDER BY class_code,pretest_score DESC,participant_name')).rows;}
export async function assignSqlClass(classCode:string,includeTests:boolean,adminId:string){
 if(!(SQL_CLASSES as readonly string[]).includes(classCode))throw new ApiError(400,'INVALID_CLASS','请选择SQL班级。');
 return transaction(async c=>{
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('sql:assign:'||$1,0))",[classCode]);
 const rows=(await c.query<CloudRow>(`SELECT p.* FROM edulab_local_backup.latest_participants p WHERE class_code=$1 AND archive->>'study_schema'=$2 AND ($3::boolean OR NOT is_test)
 AND NOT EXISTS(SELECT 1 FROM local_backup_dispositions d WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed) ORDER BY received_at DESC`,[classCode,SQL_STUDY,includeTests])).rows;
 const seen=new Set<string>();const unique=rows.filter(r=>{if(seen.has(r.participant_name))return false;seen.add(r.participant_name);return true;});
 const ready=unique.filter(r=>r.archive.study.pretest&&Number.isFinite(r.archive.study.pretest.score));
 if(unique.some(r=>!r.archive.study.pretest))throw new ApiError(409,'PRETEST_PENDING','该范围还有学生未完成前测，请先核对名单。');
 const old=(await c.query("SELECT 1 FROM sql_study_assignments WHERE class_code=$1 AND method<>'single_test_manual' LIMIT 1",[classCode])).rows;
 if(old.length)throw new ApiError(409,'ALREADY_ASSIGNED','该班已有固定分组，请勿重复分配。');
 if(ready.length<2)throw new ApiError(400,'NOT_ENOUGH_STUDENTS','至少两人完成前测后才能分组。');
 if(ready.some(r=>r.archive.study.group)&&ready.some(r=>!r.archive.study.group))throw new ApiError(409,'MIXED_LEGACY_GROUPS','该班已有历史固定分组且有未分组学生，请先核对补测名单，不能重新随机分组。');
 const assigned=matchedAssignment(ready.map(r=>({name:r.participant_name,score:r.archive.study.pretest!.score})));const batch=randomUUID();
 for(const p of assigned){const existing=ready.find(r=>r.participant_name===p.name)!.archive.study.group;
 // Preserve groups that have already driven an actual lesson; centralization cannot silently re-randomize them.
 const started=Boolean(existing);
 await c.query('INSERT INTO sql_study_assignments(class_code,participant_name,group_code,pretest_score,pair_no,batch_id,method) VALUES($1,$2,$3,$4,$5,$6,$7)',[classCode,p.name,started&&existing?existing:p.group,p.score,p.pair,batch,started&&existing?'preserved_started_local_assignment':'class_adjacent_pair_constrained_random_1500']);}
 await c.query('INSERT INTO sql_study_audit(id,admin_id,action,payload) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),adminId,'class.assign',JSON.stringify({classCode,includeTests,batch,n:assigned.length})]);return {assigned:assigned.length,batch};});
}
export async function getSqlDashboard(){const [control,records,assignments,grades,versions,testLessonControls]=await Promise.all([getSqlControl(),sqlRoster(),getSqlAssignments(),query('SELECT device_id,participant_id,lesson,scores,updated_at FROM sql_study_grades'),getSqlVersions(),getSqlTestLessonCommands()]);
 const seen=new Set<string>();const people=records.filter(r=>{const key=r.class_code+':'+r.participant_name;if(seen.has(key))return false;seen.add(key);return true;});
 const balance=SQL_CLASSES.flatMap(cls=>(['L','T'] as const).map(g=>{
   const scores=people.filter(p=>{
     const group=assignments.find(a=>a.class_code===cls&&a.participant_name===p.participant_name)?.group_code??p.archive.study.group;
     return !p.is_test&&p.class_code===cls&&group===g&&p.archive.study.pretest;
   }).map(p=>p.archive.study.pretest!.score);
   return {class_code:cls,group:g,...groupStats(scores)};
 }));
 return {...control,records,assignments,grades:grades.rows,balance,versions,testLessonControls,server_now:Date.now()/1000};}
export async function gradeSql(input:{deviceId:string;participantId:string;lesson:number;scores:number[]},adminId:string){
 const row=(await query<{archive:CloudArchive}>("SELECT archive FROM edulab_local_backup.latest_participants WHERE device_id=$1 AND participant_id=$2 AND archive->>'study_schema'=$3",[input.deviceId,input.participantId,SQL_STUDY])).rows[0];
 if(!row||!row.archive.study.rounds.find(r=>r.index===input.lesson)?.quiz)throw new ApiError(409,'QUIZ_NOT_READY','该课后测尚未提交。');
 if((row.archive.study.rounds.find(r=>r.index===input.lesson)!.quiz as {format?:string}).format==='single_choice')throw new ApiError(409,'AUTOMATIC_QUIZ','单选后测自动计分，不接受SQL题评分。');
 return transaction(async c=>{await c.query('INSERT INTO sql_study_grades(device_id,participant_id,lesson,scores,updated_by) VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(device_id,participant_id,lesson) DO UPDATE SET scores=EXCLUDED.scores,updated_by=EXCLUDED.updated_by,updated_at=now()',[input.deviceId,input.participantId,input.lesson,JSON.stringify(input.scores),adminId]);await c.query('INSERT INTO sql_study_audit(id,admin_id,action,payload) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),adminId,'quiz.grade',JSON.stringify(input)]);return {ok:true};});
}
export async function sqlClientSync(deviceId:string){const control=await getSqlControl();const [assignmentRows,grades,testCommands]=await Promise.all([query("SELECT a.* FROM sql_study_assignments a WHERE EXISTS(SELECT 1 FROM edulab_local_backup.latest_participants p WHERE p.device_id=$1 AND p.class_code=a.class_code AND p.participant_name=a.participant_name AND p.archive->>'study_schema'=$2)",[deviceId,SQL_STUDY]),query('SELECT participant_id,lesson,scores,updated_at FROM sql_study_grades WHERE device_id=$1',[deviceId]),getSqlTestLessonCommands(deviceId)]);return {...control,assignments:assignmentRows.rows,grades:grades.rows,test_lesson_commands:testCommands.map(c=>({id:c.id,device_id:c.payload.deviceId,participant_id:c.payload.participantId,lesson:c.payload.lesson,test_identity_verified:true})),server_now:Date.now()/1000};}

export type SqlVersion={revision:number;prompt_version:number;updated_at:string|null;summary:string[]};
export async function getSqlVersions(){
 const rows=(await query<SqlVersion&{config:SqlControl}>('SELECT revision,prompt_version,config,updated_at,summary FROM sql_study_versions ORDER BY revision')).rows;
 return rows.map((v,i)=>({revision:v.revision,prompt_version:v.prompt_version,updated_at:v.updated_at,summary:v.summary.some(x=>x.startsWith('历史配置更新'))&&i>0?summarizeSqlChanges(rows[i-1].config,v.config):v.summary})).reverse();
}
export async function assignSqlTest(classCode:string,name:string,group:'L'|'T',adminId:string){
 if(!(SQL_CLASSES as readonly string[]).includes(classCode))throw new ApiError(400,'INVALID_CLASS','请选择SQL班级。');
 return transaction(async c=>{
 await c.query("SELECT pg_advisory_xact_lock(hashtextextended('sql:assign:'||$1,0))",[classCode]);
 const p=(await c.query<CloudRow>("SELECT p.* FROM edulab_local_backup.latest_participants p WHERE class_code=$1 AND participant_name=$2 AND is_test AND archive->>'study_schema'=$3 ORDER BY received_at DESC LIMIT 1",[classCode,name,SQL_STUDY])).rows[0];
 if(!p)throw new ApiError(403,'TEST_IDENTITY_REQUIRED','此功能仅用于数据库明确标记的测试身份。');
 if(!p.archive.study.pretest)throw new ApiError(409,'PRETEST_PENDING','请先完成这个测试身份的基础前测。');
 const old=(await c.query<{group_code:string;method:string}>('SELECT group_code,method FROM sql_study_assignments WHERE class_code=$1 AND participant_name=$2 FOR UPDATE',[classCode,name])).rows[0];
 if(p.archive.study.rounds.some(r=>r.index!==3)&&((old?.group_code??p.archive.study.group)!==group))throw new ApiError(409,'TEST_ALREADY_STARTED','该身份已经开始课堂，不能事后更改学徒组别。');
 if(old?.group_code===group)return {ok:true,group};
 if(old&&old.method!=='single_test_manual')throw new ApiError(409,'FORMAL_ALLOCATION_LOCKED','已有配对分组不能用单人试测覆盖。');
 const batch=randomUUID();await c.query("INSERT INTO sql_study_assignments(class_code,participant_name,group_code,pretest_score,pair_no,batch_id,method) VALUES($1,$2,$3,$4,NULL,$5,'single_test_manual') ON CONFLICT(class_code,participant_name) DO UPDATE SET group_code=EXCLUDED.group_code,batch_id=EXCLUDED.batch_id,assigned_at=now()",[classCode,name,group,p.archive.study.pretest.score,batch]);
 await c.query('INSERT INTO sql_study_audit(id,admin_id,action,payload) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),adminId,'test.assign',JSON.stringify({classCode,name,group,batch,test_only:true})]);
 return {ok:true,group};});
}

export type SqlTestLessonCommand={id:string;payload:{deviceId:string;participantId:string;lesson:number};created_at:string};
export async function getSqlTestLessonCommands(deviceId:string|null=null){
 return (await query<SqlTestLessonCommand>(`SELECT DISTINCT ON (payload->>'deviceId',payload->>'participantId') id,payload,created_at
  FROM sql_study_audit WHERE action='test.lesson.select' AND ($1::text IS NULL OR payload->>'deviceId'=$1)
  ORDER BY payload->>'deviceId',payload->>'participantId',created_at DESC,id DESC`,[deviceId])).rows;
}
export async function selectSqlTestLesson(input:{deviceId:string;participantId:string;lesson:number},adminId:string){
 if(!Number.isInteger(input.lesson)||input.lesson<0||input.lesson>3)throw new ApiError(400,'INVALID_LESSON','请选择第1至4课。');
 const record=(await query<CloudRow>(`SELECT p.* FROM edulab_local_backup.latest_participants p
  WHERE p.device_id=$1 AND p.participant_id=$2 AND p.archive->>'study_schema'=$3 AND p.is_test
  AND NOT EXISTS(SELECT 1 FROM local_backup_dispositions d WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed)`,[input.deviceId,input.participantId,SQL_STUDY])).rows[0];
 if(!record)throw new ApiError(403,'TEST_IDENTITY_REQUIRED','切换课堂仅适用于已确认的测试身份。');
 const id=randomUUID();
 await query('INSERT INTO sql_study_audit(id,admin_id,action,payload) VALUES($1,$2,$3,$4::jsonb)',[id,adminId,'test.lesson.select',JSON.stringify(input)]);
 return {ok:true,id,lesson:input.lesson};
}
