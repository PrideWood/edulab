import "server-only";
import { createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/db";
import { ApiError } from "@/lib/http";
import { encryptSecret, decryptSecret } from "@/lib/secret-crypto";
import { buildSessionSnapshot, getExperimentSettings } from "@/lib/experiment-settings";
import { createRunEntryToken } from "@/lib/entry-token";
import { allocateRoster, rosterStatistics, STRATA, type RosterInput, type RosterStudent } from "@/lib/roster-allocation";

function identityHash(className: string, fullName: string) {
  const key=process.env.SETTINGS_ENCRYPTION_KEY;
  if(!key || key.length<32) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured");
  return createHmac("sha256",key).update(JSON.stringify(["roster-v1",className.trim(),fullName.trim()])).digest("hex");
}
const invalid = () => new ApiError(404,"ROSTER_NOT_FOUND","找不到当前实验的名单方案。");
const locked = () => new ApiError(409,"ROSTER_LOCKED","名单已锁定，不能重新导入或改变分配。请使用补录功能新增学生，已有学生不会重新分组。");
const rule = "班内按前测降序三等分；同分按参与姓名排序；允许导入指定层级；层内均衡，协调班级及全实验余数；确定性分配 v1";

async function audit(client: PoolClient, experimentId: string, adminId: string, action: string, data: unknown) {
  await client.query(`INSERT INTO admin_audit_log (id,admin_user_id,action,experiment_id,after_data)
    VALUES ($1,$2,$3,$4,$5::jsonb)`,[randomUUID(),adminId,action,experimentId,JSON.stringify(data)]);
}
async function validAgents(client: PoolClient, experimentId: string, agentIds: string[]) {
  const result=await client.query(`SELECT id FROM ai_agent_configs WHERE experiment_id=$1 AND enabled=true
    AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE`,[experimentId,agentIds]);
  if(agentIds.length<2 || result.rows.length!==agentIds.length) throw new ApiError(400,"INVALID_ROSTER_AGENTS","请选择至少两个本实验已启用的智能体。");
}

async function insertRosterRows(client:PoolClient,runId:string,students:RosterStudent[]) {
    const records=students.map(student=>{
      const encrypted=encryptSecret(JSON.stringify({fullName:student.fullName,score:student.score}));
      return {id:randomUUID(),class_name:student.className,identity_hash:identityHash(student.className,student.fullName),
        payload_ciphertext:encrypted.ciphertext,payload_iv:encrypted.iv,payload_tag:encrypted.tag,stratum:student.stratum,agent_id:student.agentId};
    });
    await client.query(`INSERT INTO roster_entries (id,experiment_run_id,class_name,identity_hash,payload_ciphertext,payload_iv,payload_tag,stratum,agent_id)
      SELECT x.id,$1,x.class_name,x.identity_hash,x.payload_ciphertext,x.payload_iv,x.payload_tag,x.stratum,x.agent_id
      FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,class_name text,identity_hash text,payload_ciphertext text,payload_iv text,payload_tag text,stratum text,agent_id uuid)`,[runId,JSON.stringify(records)]);
}

export async function saveRoster(input: {experimentId:string;runId?:string;version:number;name:string;agentIds:string[];students:RosterInput[];manual:boolean}, adminId:string) {
  let students: RosterStudent[];
  try { students=allocateRoster(input.students,input.agentIds,input.manual); }
  catch(error) {throw new ApiError(400,"INVALID_ROSTER",error instanceof Error?error.message:"名单无效。");}
  return transaction(async client=>{
    await validAgents(client,input.experimentId,input.agentIds);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`edulab:run:${input.experimentId}`]);
    const existing=(await client.query(`SELECT * FROM experiment_runs WHERE experiment_id=$1 AND assignment_mode='roster'
      AND entry_deleted_at IS NULL FOR UPDATE`,[input.experimentId])).rows[0];
    if(existing && (!input.runId || existing.id!==input.runId)) throw new ApiError(409,"ROSTER_EXISTS","此实验已有统一名单入口，请打开已有方案。");
    if(input.runId && !existing) throw invalid();
    if(existing?.metadata.roster_locked || (existing && existing.status!=="draft")) throw locked();
    if(Number(existing?.metadata.roster_version ?? 0)!==input.version) throw new ApiError(409,"ROSTER_STALE","名单版本已变化，请重新读取后修改。");
    const runId=existing?.id ?? randomUUID(), version=input.version+1;
    const metadata={roster_version:version,roster_locked:false,roster_rule:rule,roster_manual:input.manual};
    if(existing) {
      await client.query(`UPDATE experiment_runs SET name=$2,random_agent_ids=$3,metadata=metadata || $4::jsonb,
        updated_at=now(),updated_by=$5 WHERE id=$1`,[runId,input.name,input.agentIds,JSON.stringify(metadata),adminId]);
      await client.query("DELETE FROM roster_entries WHERE experiment_run_id=$1",[runId]);
    } else {
      const token=await createRunEntryToken(client);
      const snapshot=buildSessionSnapshot(await getExperimentSettings(input.experimentId,false));
      await client.query(`INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,random_agent_ids,
        entry_token,is_default,config_snapshot,metadata,updated_by) VALUES ($1,$2,$3,'draft','roster',$4,$5,false,$6::jsonb,$7::jsonb,$8)`,
      [runId,input.experimentId,input.name,input.agentIds,token,JSON.stringify(snapshot),JSON.stringify(metadata),adminId]);
    }
    // One statement for the complete encrypted roster; a failed write/audit rolls back the draft.
    await insertRosterRows(client,runId,students);
    await audit(client,input.experimentId,adminId,"experiment.roster.save",{runId,version,count:students.length,manual:input.manual,rule,encryptedRoster:encryptSecret(JSON.stringify(students))});
    return runId;
  });
}

export async function openRoster(experimentId:string,runId:string,version:number,adminId:string) {
  return transaction(async client=>{
    const initial=(await client.query("SELECT * FROM experiment_runs WHERE id=$1 AND experiment_id=$2 AND assignment_mode='roster'",[runId,experimentId])).rows[0];
    if(!initial) throw invalid();
    await validAgents(client,experimentId,initial.random_agent_ids);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`edulab:run:${experimentId}`]);
    const run=(await client.query("SELECT * FROM experiment_runs WHERE id=$1 FOR UPDATE",[runId])).rows[0];
    if(run.entry_deleted_at) throw invalid();
    if(run.metadata.roster_locked) throw locked();
    if(run.status!=="draft" || run.metadata.roster_version!==version || JSON.stringify(run.random_agent_ids)!==JSON.stringify(initial.random_agent_ids)) {
      throw new ApiError(409,"ROSTER_STALE","方案已变化，请重新预览后锁定。");
    }
    const count=(await client.query("SELECT count(*)::int AS n FROM roster_entries WHERE experiment_run_id=$1",[runId])).rows[0].n;
    if(!count) throw new ApiError(400,"ROSTER_EMPTY","请先保存有效名单。");
    const snapshot=buildSessionSnapshot(await getExperimentSettings(experimentId,false));
    await client.query(`UPDATE experiment_runs SET status='active',opened_at=now(),config_snapshot=$2::jsonb,
      metadata=metadata || '{"roster_locked":true}'::jsonb,updated_at=now(),updated_by=$3 WHERE id=$1`,[runId,JSON.stringify(snapshot),adminId]);
    await audit(client,experimentId,adminId,"experiment.roster.lock",{runId,version,count});
  });
}

export async function appendRoster(experimentId:string,runId:string,version:number,input:RosterInput[],adminId:string) {
  return transaction(async client=>{
    const run=(await client.query(`SELECT * FROM experiment_runs WHERE experiment_id=$1 AND id=$2 AND assignment_mode='roster'
      AND entry_deleted_at IS NULL FOR UPDATE`,[experimentId,runId])).rows[0];
    if(!run) throw invalid();
    if(!run.metadata.roster_locked) throw new ApiError(409,"ROSTER_NOT_LOCKED","草案请使用完整导入和预览流程。");
    if(run.metadata.roster_version!==version) throw new ApiError(409,"ROSTER_STALE","名单版本已变化，请刷新后补录。");
    let students:RosterStudent[];
    try {
      if(input.some(row=>!row.stratum || !row.agentId)) throw new Error("补录必须逐人明确指定层级和智能体，不会重新划层或分配已有学生。");
      students=allocateRoster(input,run.random_agent_ids,true);
    } catch(error) {throw new ApiError(400,"INVALID_ROSTER",error instanceof Error?error.message:"补录名单无效。");}
    const old=await client.query<{identity_hash:string}>("SELECT identity_hash FROM roster_entries WHERE experiment_run_id=$1",[runId]);
    if(old.rows.length+students.length>5000) throw new ApiError(400,"ROSTER_TOO_LARGE","每个名单入口最多 5000 人。");
    const hashes=new Set(old.rows.map(row=>row.identity_hash));
    if(students.some(row=>hashes.has(identityHash(row.className,row.fullName)))) throw new ApiError(409,"ROSTER_DUPLICATE","补录的班级与参与姓名已存在，请核对，不会覆盖原分配。");
    await insertRosterRows(client,runId,students);
    await client.query(`UPDATE experiment_runs SET metadata=metadata || jsonb_build_object('roster_version',$2::int),updated_at=now(),updated_by=$3 WHERE id=$1`,[runId,version+1,adminId]);
    await audit(client,experimentId,adminId,"experiment.roster.append",{runId,version:version+1,count:students.length,encryptedRoster:encryptSecret(JSON.stringify(students))});
  });
}

export async function getRosters(experimentId:string) {
  return transaction(async client=>{
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    const runs=(await client.query(`SELECT id,name,status,entry_token,entry_deleted_at,random_agent_ids,metadata FROM experiment_runs
      WHERE experiment_id=$1 AND assignment_mode='roster' ORDER BY created_at DESC`,[experimentId])).rows;
    const rows=(await client.query(`SELECT r.*,p.external_code,
        (SELECT count(*)::int FROM experiment_sessions s WHERE s.participant_id=r.participant_id AND s.experiment_run_id=r.experiment_run_id) AS session_count,
        EXISTS(SELECT 1 FROM experiment_sessions s WHERE s.participant_id=r.participant_id AND s.experiment_run_id=r.experiment_run_id AND s.status='completed') AS has_completed
      FROM roster_entries r JOIN experiment_runs run ON run.id=r.experiment_run_id LEFT JOIN participants p ON p.id=r.participant_id
      WHERE run.experiment_id=$1 ORDER BY r.class_name,r.id`,[experimentId])).rows;
    return runs.map(run=>{
      const students=rows.filter(row=>row.experiment_run_id===run.id).map(row=>({
        ...JSON.parse(decryptSecret({ciphertext:row.payload_ciphertext,iv:row.payload_iv,tag:row.payload_tag})),
        className:row.class_name,stratum:row.stratum,agentId:row.agent_id,participantCode:row.external_code ?? "",
        sessionCount:row.session_count,hasCompleted:row.has_completed,
      })) as (RosterStudent & {participantCode:string;sessionCount:number;hasCompleted:boolean})[];
      students.sort((a,b)=>(a.className<b.className?-1:a.className>b.className?1:0) || STRATA.indexOf(a.stratum)-STRATA.indexOf(b.stratum) || b.score-a.score || (a.fullName<b.fullName?-1:a.fullName>b.fullName?1:0));
      return {id:run.id,name:run.name,status:run.status,entryToken:run.entry_token,entryDeletedAt:run.entry_deleted_at,
        agentIds:run.random_agent_ids as string[],version:Number(run.metadata.roster_version),locked:Boolean(run.metadata.roster_locked),
        manual:Boolean(run.metadata.roster_manual),rule:run.metadata.roster_rule as string,students,statistics:rosterStatistics(students,run.random_agent_ids)};
    });
  });
}

export async function rosterClasses(runId:string) {
  return (await query<{class_name:string}>(`SELECT DISTINCT r.class_name FROM roster_entries r JOIN experiment_runs run ON run.id=r.experiment_run_id
    WHERE run.id=$1 AND run.assignment_mode='roster' AND run.metadata->>'roster_locked'='true' AND run.entry_deleted_at IS NULL ORDER BY r.class_name`,[runId])).rows.map(row=>row.class_name);
}

/** Claim exactly one preassigned row before creating any participant. No random fallback. */
export async function claimRosterEntry(client:PoolClient,runId:string,className:string,fullName:string) {
  const run=(await client.query(`SELECT status,metadata FROM experiment_runs WHERE id=$1 AND assignment_mode='roster'
    AND entry_deleted_at IS NULL FOR SHARE`,[runId])).rows[0];
  if(!run || run.status!=="active" || !run.metadata.roster_locked) throw new ApiError(409,"ROSTER_CLOSED","此名单入口尚未开放新报名，请联系教师。已有编号可继续恢复。");
  const row=(await client.query(`SELECT id,participant_id,agent_id FROM roster_entries WHERE experiment_run_id=$1 AND identity_hash=$2 FOR UPDATE`,
    [runId,identityHash(className,fullName)])).rows[0];
  if(!row) throw new ApiError(404,"ROSTER_IDENTITY_MISMATCH","班级或参与姓名与名单不匹配，请核对教师提供的信息。");
  if(row.participant_id) throw new ApiError(409,"ROSTER_ALREADY_REGISTERED","此名单身份已有实验记录，请使用原编号和当前姓名继续之前的实验；忘记编号请联系教师。");
  return row.id as string;
}
