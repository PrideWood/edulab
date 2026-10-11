import { getStudentEntry, sessionCookieName } from "@/lib/experiment-entry";
import { sessionTransaction } from "@/lib/session-write";
import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/db";
import { buildSessionSnapshot, getExperimentSettings, type ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import { ApiError, errorResponse } from "@/lib/http";
import { getSessionControls } from "@/lib/experiment-limits";
import { getAuthenticatedSession, type AuthenticatedSession } from "@/lib/session";
import { buildSessionPayload } from "@/lib/session-payload";
import { parseSessionCookie } from "@/lib/security";
import { clearRuntimeCookie } from "@/lib/runtime-session";
import { assertSameOrigin } from "@/lib/admin-auth";
import { captureSessionMemory } from "@/lib/session-memory";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("switch"), sessionId: z.uuid() }),
  z.object({ action:z.literal("start_interaction"),clientRequestId:z.uuid(),expectedSessionId:z.uuid() }),
]);

interface SessionRow {
  id: string; public_id: string; participant_id: string; experiment_id: string;
  status: "active" | "completed"; coze_user_id: string; coze_conversation_id: string | null;
  dify_conversation_id: string | null;
  active_request_id: string | null; started_at: string; last_activity_at: string;
  config_version: number | null; config_snapshot: ExperimentSessionSnapshot | null;
  session_secret_hash: string;
}

function authenticatedFromRow(row: SessionRow, participantCode: string): AuthenticatedSession {
  return {
    id: row.id, publicId: row.public_id, participantId: row.participant_id,
    participantCode, experimentId: row.experiment_id, status: row.status,
    cozeUserId: row.coze_user_id, cozeConversationId: row.coze_conversation_id,
    difyConversationId: row.dify_conversation_id ?? null,
    activeRequestId: row.active_request_id, startedAt: row.started_at,
    lastActivityAt: row.last_activity_at, configVersion: row.config_version,
    configSnapshot: row.config_snapshot, sessionSecretHash: row.session_secret_hash,
  };
}

async function listConversations(session: AuthenticatedSession) {
  const result = await query<{
    public_id: string; status: "active" | "completed"; started_at: string;
    last_activity_at: string; title: string;
  }>(
    `SELECT public_id, status, started_at, last_activity_at,
       COALESCE(NULLIF(metadata->>'conversation_title', ''), '新对话') AS title
     FROM experiment_sessions
     WHERE participant_id = $1 AND experiment_id = $2
       AND experiment_run_id IS NOT DISTINCT FROM (SELECT experiment_run_id FROM experiment_sessions WHERE id=$3)
     ORDER BY started_at DESC,id DESC`,
    [session.participantId, session.experimentId, session.id],
  );
  return result.rows.map((row) => ({
    id: row.public_id, title: row.title, status: row.status,
    startedAt: row.started_at, lastActivityAt: row.last_activity_at,
  }));
}

function setSessionCookie(response: NextResponse, publicId: string, secret: string, cookieName: string) {
  response.cookies.set(cookieName, `${publicId}.${secret}`, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 60 * 60 * 8,
  });
}

export async function GET(request?: Request) {
  try {
    const session = await getAuthenticatedSession(await getStudentEntry(request));
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    return NextResponse.json({ conversations: await listConversations(session), currentSessionId: session.publicId });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const entry = await getStudentEntry(request);
    const current = await getAuthenticatedSession(entry);
    if (!current) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const parsedCookie = parseSessionCookie((await cookies()).get(sessionCookieName(entry))?.value);
    if (!parsedCookie) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_CONVERSATION_ACTION", "对话操作无效。");
    let target: AuthenticatedSession;
    if (input.data.action === "create" || input.data.action === "start_interaction") {
      const action = input.data;
      const independent = action.action === "start_interaction";
      if (!independent && current.status === "completed") throw new ApiError(409, "SESSION_COMPLETED", "本次实验已经结束，不能重新开始。");
      const controls = await getSessionControls(current);
      if (!independent && !controls.controls.chatEnabled) throw new ApiError(403, "CHAT_DISABLED", "本次实验未开放 AI 对话。");
      if (!independent && controls.controls.remainingMessages === 0) throw new ApiError(409, "MESSAGE_LIMIT_REACHED", "已经达到本次实验允许的交流次数。");
      if (!independent && controls.controls.endsAt && new Date(controls.controls.endsAt).getTime() <= Date.now()) throw new ApiError(409, "TIME_LIMIT_REACHED", "本次实验的交流时间已经结束。");
      const snapshot = independent ? {...buildSessionSnapshot(await getExperimentSettings(current.experimentId,false)),ai:controls.snapshot.ai}
        : controls.snapshot;
      if (!snapshot.experiment.chatEnabled) throw new ApiError(403,"CHAT_DISABLED","当前项目未开放 AI 交互，请联系教师。");
      const row = await sessionTransaction(current, async (client) => {
        const source = (await client.query<SessionRow & {metadata:{interaction_id?:string}}>(
          "SELECT * FROM experiment_sessions WHERE id=$1 FOR UPDATE",[current.id])).rows[0];
        if (independent) {
          const replay = await client.query<SessionRow>(`SELECT * FROM experiment_sessions WHERE participant_id=$1 AND experiment_id=$2
            AND experiment_run_id IS NOT DISTINCT FROM $3::uuid AND metadata->>'start_request_id'=$4`,
          [current.participantId,current.experimentId,snapshot.ai.runId ?? null,action.clientRequestId]);
          if (replay.rows[0]) {
            await client.query("UPDATE experiment_sessions SET session_secret_hash=$2 WHERE id=$1", [replay.rows[0].id,current.sessionSecretHash]);
            await client.query("UPDATE participants SET metadata=jsonb_set(metadata,'{resume_session_id}',to_jsonb($2::text),true) WHERE id=$1",
              [current.participantId,replay.rows[0].public_id]);
            return {...replay.rows[0],session_secret_hash:current.sessionSecretHash};
          }
          if (action.expectedSessionId!==current.publicId) throw new ApiError(409,"SESSION_CHANGED","当前会话已改变，请刷新后核对再开始新交互。");
          const latest = (await client.query<{id:string}>(`SELECT id FROM experiment_sessions WHERE participant_id=$1 AND experiment_id=$2
            AND experiment_run_id IS NOT DISTINCT FROM $3::uuid ORDER BY started_at DESC,id DESC LIMIT 1`,
          [current.participantId,current.experimentId,snapshot.ai.runId ?? null])).rows[0];
          if (latest?.id!==current.id) throw new ApiError(409,"NEWER_INTERACTION_EXISTS","已有更新的交互会话，请先从列表进入最近一次交互，系统不会重复创建。");
          if (!snapshot.ai.runId || !snapshot.ai.agentId || entry?.runId && entry.runId!==snapshot.ai.runId) {
            throw new ApiError(409,"SESSION_BINDING_MISSING","历史会话缺少原分组或智能体绑定，请联系教师核验，系统不会重新分组。");
          }
          const agent = (await client.query<{provider:string;coze_api_base_url:string;coze_bot_id:string|null}>(
            `SELECT a.provider,a.coze_api_base_url,a.coze_bot_id FROM ai_agent_configs a JOIN experiment_runs r ON r.id=$3
             WHERE a.id=$1 AND a.experiment_id=$2 AND r.experiment_id=$2 AND r.entry_deleted_at IS NULL
               AND EXISTS (SELECT 1 FROM participant_identity_profiles WHERE participant_id=$4)
               AND NOT EXISTS (SELECT 1 FROM participant_agent_assignments
                 WHERE experiment_run_id=$3 AND participant_id=$4 AND agent_id<>$1)`,
          [snapshot.ai.agentId,current.experimentId,snapshot.ai.runId,current.participantId])).rows[0];
          if (!agent || agent.provider!==(snapshot.ai.provider ?? "coze") || agent.coze_api_base_url!==snapshot.ai.baseUrl
            || (agent.coze_bot_id ?? "")!==snapshot.ai.botId) throw new ApiError(409,"SESSION_BINDING_CHANGED","原智能体绑定无法确认，请联系教师，系统不会改用其他智能体。");
          const busy = await client.query<{busy:boolean}>(`SELECT EXISTS (SELECT 1 FROM experiment_sessions s
            WHERE s.participant_id=$1 AND s.experiment_id=$2 AND s.experiment_run_id=$3 AND
              (s.active_request_id IS NOT NULL OR EXISTS (SELECT 1 FROM chat_requests WHERE session_id=s.id AND status='in_progress'))) AS busy`,
          [current.participantId,current.experimentId,snapshot.ai.runId]);
          if (busy.rows[0].busy) throw new ApiError(409,"SESSION_BUSY","请等待既有交互的 AI 回复恢复完成后，再开始新一次交互。");
          await client.query(`UPDATE experiment_sessions SET status='completed',completed_at=COALESCE(completed_at,now()),
            metadata=metadata || '{"completion_source":"new_interaction","end_reason":"next_learning_task"}'::jsonb
            WHERE participant_id=$1 AND experiment_id=$2 AND experiment_run_id=$3 AND status='active'
              AND (metadata->>'interaction_id') IS NOT DISTINCT FROM $4::text`,
          [current.participantId,current.experimentId,snapshot.ai.runId,source.metadata.interaction_id ?? null]);
        } else if (source.status!=="active") throw new ApiError(409,"SESSION_COMPLETED","本次实验已经结束，不能重新开始。");
        const id = randomUUID();
        const publicId = randomUUID();
        const metadata = {conversation_title:"新对话",transcript_authority:"server",
          ...(independent ? {interaction_id:id,start_request_id:action.clientRequestId,previous_session_id:current.publicId}
            : source.metadata.interaction_id ? {interaction_id:source.metadata.interaction_id} : {})};
        const inserted = await client.query<SessionRow>(
          `INSERT INTO experiment_sessions (id, public_id, participant_id, experiment_id, session_secret_hash,
             coze_user_id, config_version, config_snapshot, started_at, last_activity_at, metadata,
             experiment_run_id, agent_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,clock_timestamp(),clock_timestamp(),$9::jsonb,$10,$11)
           RETURNING id, public_id, participant_id, experiment_id, status, coze_user_id,
             coze_conversation_id, dify_conversation_id, active_request_id, started_at, last_activity_at,
             config_version, config_snapshot, session_secret_hash`,
          [id, publicId, current.participantId, current.experimentId, current.sessionSecretHash,
            `edulab_${publicId.replaceAll("-", "")}`, snapshot.version, JSON.stringify(snapshot), JSON.stringify(metadata),
            snapshot.ai.runId ?? null, snapshot.ai.agentId ?? null],
        );
        if (independent) await captureSessionMemory(client,{...current,id,configSnapshot:snapshot},true);
        await client.query(`UPDATE participants SET metadata=jsonb_set(metadata,'{resume_session_id}',to_jsonb($2::text),true) WHERE id=$1`,
          [current.participantId,publicId]);
        return inserted.rows[0];
      });
      target = authenticatedFromRow(row, current.participantCode);
    } else {
      const result = await query<SessionRow>(
        `SELECT id, public_id, participant_id, experiment_id, status, coze_user_id,
           coze_conversation_id, dify_conversation_id, active_request_id, started_at, last_activity_at,
           config_version, config_snapshot, session_secret_hash
         FROM experiment_sessions
         WHERE public_id = $1 AND participant_id = $2 AND experiment_id = $3
           AND experiment_run_id IS NOT DISTINCT FROM (SELECT experiment_run_id FROM experiment_sessions WHERE id=$4)`,
        [input.data.sessionId, current.participantId, current.experimentId, current.id],
      );
      if (!result.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "找不到这个对话。");
      target = authenticatedFromRow(result.rows[0], current.participantCode);
      await sessionTransaction(current, async (client) => {
        await client.query(`UPDATE participants SET metadata=jsonb_set(metadata, '{resume_session_id}', to_jsonb($2::text), true) WHERE id=$1`, [current.participantId, target.publicId]);
        await client.query("UPDATE experiment_sessions SET session_secret_hash=$2 WHERE id=$1",[target.id,current.sessionSecretHash]);
      });
      target.sessionSecretHash = current.sessionSecretHash;
    }
    const payload = await buildSessionPayload(target);
    const response = NextResponse.json({
      payload,
      conversations: await listConversations(target),
    });
    setSessionCookie(response, target.publicId, parsedCookie.secret, sessionCookieName(entry));
    if (!entry) clearRuntimeCookie(response);
    return response;
  } catch (error) { return errorResponse(error); }
}
