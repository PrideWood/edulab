import 'server-only';
import {randomBytes,createHash,timingSafeEqual} from 'node:crypto';
import type {PoolClient} from 'pg';
import {query,transaction} from '@/db';
import {getSqlControl} from './sql-study-control';
import {getSharedModelConnection} from './shared-model';
import {generateOnlineReply} from './sql-online-model';
import {freshStudent,publicStudent,applyStudentAction,studentQuestions,beginStudentChat,completeStudentChat,recoverInterrupted,applyCloudSync,StudentError,type Data} from './sql-online-engine';
export {StudentError};
export const DEVICE_COOKIE='sql_online_device';
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
export const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const now=()=>Date.now()/1000;
export function cookie(request:Request,name:string){const raw=request.headers.get('cookie')??'';return raw.split(';').map(x=>x.trim()).find(x=>x.startsWith(name+'='))?.slice(name.length+1);}
export function sameOrigin(request:Request){const origin=request.headers.get('origin');const url=new URL(request.url);const host=request.headers.get('host')??url.host;let valid=false;try{const parsed=new URL(origin??'');valid=parsed.host===host&&parsed.protocol===(process.env.NODE_ENV==='production'?'https:':url.protocol);}catch{valid=false;}if(!valid)throw new StudentError('不允许跨站提交。',403);}
interface OnlineRow{device_id:string;participant_id:string;session_hash:string;state:Data;revision:string}
function verify(row:OnlineRow|undefined,token:string){if(!row||token.length<32||token.length>128)throw new StudentError('本机身份失效，请重新登录。',401);const value=digest(token);if(!timingSafeEqual(Buffer.from(value),Buffer.from(row.session_hash)))throw new StudentError('本机身份失效，请重新登录。',401);}
async function save(c:PoolClient,row:OnlineRow,p:Data,archive:boolean){const revision=(await c.query<{revision:string}>('UPDATE sql_online_students SET state=$3::jsonb,revision=revision+1,updated_at=now() WHERE device_id=$1 AND participant_id=$2 RETURNING revision::text',[row.device_id,row.participant_id,JSON.stringify(p)])).rows[0].revision;
 if(archive){const snapshot:Data={schema_version:'edulab-light/1',study_schema:'sql-teachable-mvp/1',source_app:'student-light',device_id:row.device_id,participant:{id:p.id,name:p.name,class_code:p.class_code,created_at:p.created_at},study:p,backup_revision:Number(revision),delivery_mode:'online',conversations:p.rounds.map((r:Data)=>({id:r.id,title:r.task.title,created_at:r.created_at,agent:{provider:r.config.mode,group:r.group,study:'sql-teachable-mvp/1'},messages:r.messages,requests:r.requests}))};const canonical=JSON.stringify(snapshot),sha=digest(canonical);await c.query('SELECT edulab_local_backup.ingest($1::text,$2::text,$3::text,$4::text)',[row.device_id+':'+p.id+':'+sha,sha,canonical,new Date().toISOString()]);}
}
export async function onlineEnter(device:string,input:Data){const {config}=await getSqlControl();const name=typeof input.name==='string'?input.name.normalize('NFKC').trim():'',cls=input.class_code;if(input.confirmed!==true||!config.classes.some(c=>c.enabled&&c.code===cls)||!name||name.length>30||[...name].some(ch=>ch.charCodeAt(0)<32))throw new StudentError('请选择班级并确认真实姓名（最多30字）。');
 const token=randomBytes(32).toString('base64url');return transaction(async c=>{
 await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[device+':'+cls+':'+name]);let row=(await c.query<OnlineRow>('SELECT device_id,participant_id,session_hash,state,revision::text FROM sql_online_students WHERE device_id=$1 AND class_code=$2 AND participant_name=$3 FOR UPDATE',[device,cls,name])).rows[0];
 if(!row){const n=(await c.query<{n:number}>('SELECT count(*)::int n FROM sql_online_students WHERE device_id=$1',[device])).rows[0].n;if(n>=20)throw new StudentError('此浏览器已创建过多身份，请联系教师。',429);const p=freshStudent(cls,name,now());p.test_cleanup_epoch=config.test_cleanup_epoch;row=(await c.query<OnlineRow>('INSERT INTO sql_online_students(device_id,participant_id,class_code,participant_name,session_hash,state) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING device_id,participant_id,session_hash,state,revision::text',[device,p.id,cls,name,digest(token),JSON.stringify(p)])).rows[0];}
 else await c.query('UPDATE sql_online_students SET session_hash=$3 WHERE device_id=$1 AND participant_id=$2',[device,row.participant_id,digest(token)]);
 recoverInterrupted(row.state,now());await save(c,row,row.state,true);return {...publicStudent(row.state,config,now()),session_token:token};});}
export async function onlineCall(device:string,participant:string,token:string,kind:string,input:Data={}){
 if(!uuid(device)||!uuid(participant))throw new StudentError('本机身份失效，请重新登录。',401);
 const sync=(await query<{payload:Data}>('SELECT edulab_local_backup.sql_student_sync($1::uuid) AS payload',[device])).rows[0].payload;const config=sync.config as Awaited<ReturnType<typeof getSqlControl>>['config'];
 return transaction(async c=>{const row=(await c.query<OnlineRow>('SELECT device_id,participant_id,session_hash,state,revision::text FROM sql_online_students p WHERE device_id=$1 AND participant_id=$2 AND NOT EXISTS(SELECT 1 FROM local_backup_dispositions d WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed) FOR UPDATE',[device,participant])).rows[0];verify(row,token);const p=row.state;p.client_version='0.13.0';p.measurement_policy='required-no-prediction/1';const at=now();

 recoverInterrupted(p,at);const before=JSON.stringify([p.group,p.test_lesson_control]);applyCloudSync(p,sync,at);let archive=JSON.stringify([p.group,p.test_lesson_control])!==before;let result:unknown;
 if(kind==='questions')result=studentQuestions(p,config,input.kind,input.round_id,at);
 else if(kind==='action'){if(typeof input.action!=='string')throw new StudentError('缺少操作类型。');applyStudentAction(p,config,input.action,input,at);archive||=!['teaching_presence','measurement_draft','draft','quiz_draft','begin_measurement'].includes(input.action);}
 else if(kind==='chat'){const pending=beginStudentChat(p,config,input,at);result=structuredClone(pending);archive=!pending.duplicate;}
 else if(!['state','refresh'].includes(kind))throw new StudentError('未找到接口。',404);
 const publicValue=publicStudent(p,config,at);await save(c,row,p,archive);return result??publicValue;});
}
async function finish(device:string,participant:string,round:string,req:string,result:Data|null,error?:string){return transaction(async c=>{const row=(await c.query<OnlineRow>('SELECT device_id,participant_id,session_hash,state,revision::text FROM sql_online_students WHERE device_id=$1 AND participant_id=$2 FOR UPDATE',[device,participant])).rows[0];if(!row)return;try{completeStudentChat(row.state,round,req,result,now(),error);}catch{completeStudentChat(row.state,round,req,null,now(),'学徒回复结构不完整，请重新发送。');}await save(c,row,row.state,true);});}
export async function onlineChat(device:string,participant:string,token:string,input:Data){const job=await onlineCall(device,participant,token,'chat',input) as {duplicate?:string;round:Data;request:Data};if(job.duplicate)return {status:job.duplicate,request_id:job.request.id};const {round:r,request:q}=job;
 try{let result:Data;
 if(q.closing)result={};
 else if(r.config.mode==='demo')result={reply:'老师，我想确认一下：'+r.config.research_questions[r.index][r.group==='T'?q.turn_index-1:Math.min(q.turn_index,5)],target:(q.turn_index-1)%6,reason:'演示规则，非掌握判断',knowledge:r.knowledge,source:'demo-rule-not-mastery-assessment'};
 else{result=await generateOnlineReply(r,q,await getSharedModelConnection());}
 await finish(device,participant,r.id,q.id,result);return {status:'completed',request_id:q.id};
 }catch(e){console.warn('sql.online.model.failure',{kind:e instanceof Error?e.name:'unknown',code:e&&typeof e==='object'&&'code' in e?e.code:undefined});const message=e instanceof StudentError?e.message:e instanceof Error&&e.name==='TimeoutError'?'模型响应超时，请稍后重发。':'学徒连接暂未完成，讲解已保存，可以重新发送。';await finish(device,participant,r.id,q.id,null,message);return {status:'failed',request_id:q.id};}
}
export async function onlineClasses(){const {config}=await getSqlControl();return {classes:config.classes.filter(c=>c.enabled).map(c=>({code:c.code,label:c.label}))};}
