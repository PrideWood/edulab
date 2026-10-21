import { NextResponse } from "next/server";
import { z } from "zod";
import { getAuthenticatedAdmin, assertSameOrigin } from "@/lib/admin-auth";
import { getAdminExperimentId } from "@/lib/experiment-entry";
import { getRosters, openRoster, saveRoster, appendRoster } from "@/lib/roster";
import { closeActiveExperimentRun, reopenExperimentRun, deleteExperimentRunLink, getAgentControl } from "@/lib/agent-control";
import { rosterCsv } from "@/lib/roster-allocation";
import { query } from "@/db";
import { randomUUID } from "node:crypto";
import { ApiError, errorResponse } from "@/lib/http";
import { buildInteractionArchive } from "@/lib/admin-export";
import { experimentRosterEnabled } from "@/lib/experiments";

export const runtime = "nodejs";
export const maxDuration = 60;

async function assertRosterSchema() {
  const result = await query<{ ready: boolean }>(`SELECT to_regclass('roster_entries') IS NOT NULL AND EXISTS (
    SELECT 1 FROM pg_attribute WHERE attrelid='experiments'::regclass
      AND attname='roster_enabled' AND NOT attisdropped) AS ready`);
  if (!result.rows[0].ready) {
    throw new ApiError(503, "ROSTER_MIGRATION_REQUIRED", "名单功能尚未初始化，请先执行数据库迁移至 0017；原有实验入口可继续使用。");
  }
}

async function rosterExperiment(request: Request) {
  const experimentId = await getAdminExperimentId(request);
  await assertRosterSchema();
  if (!await experimentRosterEnabled(experimentId)) {
    throw new ApiError(403, "ROSTER_NOT_ENABLED", "此实验沿用原有入口设置；名单分层功能仅对新增实验开放。");
  }
  return experimentId;
}
const row=z.object({className:z.string().trim().min(1).max(100),fullName:z.string().trim().min(1).max(100),
  score:z.number().finite().min(-1e9).max(1e9),stratum:z.enum(["高","中","低"]).optional(),agentId:z.uuid().optional()});
const schema=z.discriminatedUnion("action",[
  z.object({action:z.literal("save"),runId:z.uuid().optional(),version:z.number().int().nonnegative(),name:z.string().trim().min(1).max(120),
    agentIds:z.array(z.uuid()).min(2).max(20),students:z.array(row).min(1).max(5000),manual:z.boolean()}),
  z.object({action:z.literal("lock"),runId:z.uuid(),version:z.number().int().positive()}),
  z.object({action:z.literal("append"),runId:z.uuid(),version:z.number().int().positive(),students:z.array(row).min(1).max(5000)}),
  z.object({action:z.enum(["close","reopen"]),runId:z.uuid()}),
  z.object({action:z.enum(["export","interactions_export"]),runId:z.uuid(),agentId:z.uuid().optional()}),
  z.object({action:z.literal("delete"),runId:z.uuid(),confirmationCode:z.string().trim().min(1).max(32)}),
]);
const noStore={"Cache-Control":"private, no-store"};
export async function GET(request:Request) {
  try {
    if(!await getAuthenticatedAdmin()) throw new ApiError(401,"ADMIN_REQUIRED","请先登录管理后台。");
    const experimentId = await rosterExperiment(request);
    return NextResponse.json({rosters:await getRosters(experimentId)},{headers:noStore});
  } catch(error) {return errorResponse(error);}
}
export async function POST(request:Request) {
  try {
    assertSameOrigin(request);
    const admin=await getAuthenticatedAdmin();
    if(!admin) throw new ApiError(401,"ADMIN_REQUIRED","请先登录管理后台。");
    const experimentId=await rosterExperiment(request);
    const text=await request.text();
    if(Buffer.byteLength(text)>3_000_000) throw new ApiError(413,"ROSTER_TOO_LARGE","名单文件过大，最多支持 5000 人。");
    let body;try {body=JSON.parse(text);}catch {throw new ApiError(400,"INVALID_ROSTER","请求格式无效。");}
    const input=schema.safeParse(body);
    if(!input.success) throw new ApiError(400,"INVALID_ROSTER",input.error.issues[0]?.message ?? "名单参数无效。");
    const data=input.data;
    if(data.action==="save") await saveRoster({...data,experimentId},admin.id);
    else {
      const roster=(await getRosters(experimentId)).find(item=>item.id===data.runId);
      if(!roster) throw new ApiError(404,"ROSTER_NOT_FOUND","找不到此名单方案。");
      if(data.action==="export" || data.action==="interactions_export") {
        if(data.agentId && !roster.agentIds.includes(data.agentId)) throw new ApiError(400,"INVALID_ROSTER_AGENT","此智能体不属于名单方案。");
        const students=roster.students.filter(student=>!data.agentId || student.agentId===data.agentId);
        if(data.action==="interactions_export") {
          const ids=(await query<{participant_id:string}>(`SELECT participant_id FROM roster_entries WHERE experiment_run_id=$1
            AND participant_id IS NOT NULL AND ($2::uuid IS NULL OR agent_id=$2) ORDER BY id`,[roster.id,data.agentId ?? null])).rows.map(row=>row.participant_id);
          if(!ids.length || ids.length>500) throw new ApiError(400,"INVALID_ROSTER_EXPORT","请先筛选智能体组，一次支持导出 1–500 位已进入的参与者。");
          const archive=await buildInteractionArchive({experimentId,runId:roster.id,participantIds:ids,adminUserId:admin.id});
          return new Response(Uint8Array.from(archive.bytes).buffer,{headers:{...noStore,"Content-Type":"application/zip","Content-Disposition":`attachment; filename="${archive.filename}"`}});
        }
        const agents=(await getAgentControl(experimentId)).agents;
        const csv=rosterCsv([["班级","参与姓名","前测成绩","层级","智能体","agentId","被试编号","参与状态","交互次数","方案版本","分配规则"],
          ...students.map(student=>[student.className,student.fullName,student.score,student.stratum,
            agents.find(agent=>agent.id===student.agentId)?.internalName ?? student.agentId,student.agentId,student.participantCode,
            student.hasCompleted?"已有完成交互":student.participantCode?"已进入":"未进入",student.sessionCount,roster.version,roster.rule])]);
        await query(`INSERT INTO admin_audit_log (id,admin_user_id,action,experiment_id,after_data) VALUES ($1,$2,'experiment.roster.export',$3,$4::jsonb)`,
          [randomUUID(),admin.id,experimentId,JSON.stringify({runId:roster.id,version:roster.version,count:roster.students.length})]);
        return new Response(csv,{headers:{...noStore,"Content-Type":"text/csv; charset=utf-8","Content-Disposition":'attachment; filename="roster-allocation.csv"'}});
      }
      if(data.action==="append") await appendRoster(experimentId,data.runId,data.version,data.students,admin.id);
      else if(data.action==="lock") await openRoster(experimentId,data.runId,data.version,admin.id);
      else if(data.action==="close") await closeActiveExperimentRun(experimentId,admin.id,data.runId);
      else if(data.action==="reopen") await reopenExperimentRun(experimentId,data.runId,admin.id);
      else if(data.action==="delete") await deleteExperimentRunLink({experimentId,runId:data.runId,confirmationCode:data.confirmationCode},admin.id);
    }
    return NextResponse.json({rosters:await getRosters(experimentId),control:await getAgentControl(experimentId)},{headers:noStore});
  } catch(error) {
    const messages:Record<string,string>={RUN_NOT_CLOSED:"请先停止新报名，再删除链接。",RUN_CONFIRMATION_MISMATCH:"入口码不一致，未删除。",
      RUN_BUSY:"仍有 AI 回复生成中，请等待完成。",RUN_ENTRY_DELETED:"链接已删除。",RUN_AGENT_UNAVAILABLE:"请检查智能体是否可用。",ROSTER_NOT_LOCKED:"请先预览并锁定名单。"};
    if(error instanceof Error && messages[error.message]) return errorResponse(new ApiError(409,error.message,messages[error.message]));
    return errorResponse(error);
  }
}
