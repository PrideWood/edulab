import type { ParticipantProfile } from "@/lib/client-types";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getStudentEntry, sessionCookieName } from "@/lib/experiment-entry";
import { experiment } from "@/config/experiment";
import { transaction } from "@/db";
import { errorResponse, ApiError } from "@/lib/http";
import { getAuthenticatedSession, type AuthenticatedSession } from "@/lib/session";
import { buildSessionPayload } from "@/lib/session-payload";
import { hashSecret, newSessionSecret, normalizeParticipantCode, verifyParticipantAccess } from "@/lib/security";
import { buildSessionSnapshot, getExperimentSettings } from "@/lib/experiment-settings";
import { profileFromRow, saveParticipantProfileWithClient } from "@/lib/participant-profile";
import { isTestParticipantName } from "@/lib/participant-code";
import { createParticipantWithAvailableCode } from "@/lib/participant-code-allocation";
import { assignAgentWithClient } from "@/lib/agent-control";
import { clearRuntimeCookie } from "@/lib/runtime-session";
import { assertSameOrigin } from "@/lib/admin-auth";
import { importLegacyRuntime } from "@/lib/legacy-runtime";
import { captureSessionMemory } from "@/lib/session-memory";
import { claimRosterEntry } from "@/lib/roster";

export const runtime = "nodejs";
export const maxDuration = 120;

const profileSchema = z.object({
  fullName: z.string().trim().min(1, "请填写姓名，学号可以不填。").max(100),
  studentNumber: z.string().trim().max(100).default(""),
});

const inputSchema = z.object({
  participantCode: z.string().trim().min(1).max(80).optional(),
  access: z.string().max(200).optional(),
  profile: profileSchema.optional(),
  registrationRequestId:z.uuid().optional(),
  rosterClass:z.string().trim().min(1).max(100).optional(),
}).superRefine((value, context) => {
  if (value.access && !value.participantCode) {
    context.addIssue({ code: "custom", message: "参与者链接信息无效。" });
  }
  if (!value.participantCode && !value.profile) {
    context.addIssue({ code: "custom", message: "请先填写参与者信息。" });
  }
});

export async function GET(request?: Request) {
  try {
    const entry = await getStudentEntry(request);
    const session = await getAuthenticatedSession(entry);
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "请通过研究者提供的实验链接进入。 ");
    await importLegacyRuntime(session);
    const response = NextResponse.json(await buildSessionPayload(session), { headers: { "Cache-Control": "private, no-store" } });
    if (!entry) clearRuntimeCookie(response);
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message === "NO_ACTIVE_EXPERIMENT_RUN") return errorResponse(new ApiError(409, message, "当前没有开放的实验场次，请联系教师。"));
    if (message === "NO_AVAILABLE_AGENT") return errorResponse(new ApiError(409, message, "当前场次没有可用的智能体，请联系教师。"));
    if (message === "COZE_TOKEN_NOT_CONFIGURED") return errorResponse(new ApiError(503, message, "当前智能体尚未配置 API Token，请联系教师。"));
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_PARTICIPANT", input.error.issues[0]?.message ?? "参与者信息无效。");
    const entry = await getStudentEntry(request);
    const experimentId = entry?.experimentId ?? experiment.id;
    const current = await getAuthenticatedSession(entry);
    if (!input.data.participantCode && current?.experimentId === experimentId) {
      return NextResponse.json(await buildSessionPayload(current));
    }
    const requestedParticipantCode = input.data.participantCode
      ? normalizeParticipantCode(input.data.participantCode)
      : null;
    if (current && current.experimentId === experimentId && current.participantCode === requestedParticipantCode) {
      return NextResponse.json(await buildSessionPayload(current));
    }
    if (requestedParticipantCode && !verifyParticipantAccess(requestedParticipantCode, input.data.access, experimentId)) {
      throw new ApiError(403, "INVALID_EXPERIMENT_LINK", "实验链接无效或已被修改，请使用研究者提供的完整链接。");
    }

    if (entry && entry.status !== "active") throw new ApiError(409, "ENTRY_CLOSED", "此场次已结束，新参与者不能进入；已有记录可使用恢复入口查看。");
    const secret = newSessionSecret();
    const publicId = randomUUID();
    const sessionId = randomUUID();
    const settings = await getExperimentSettings(experimentId,false);
    const baseSnapshot = { ...(entry?.snapshot ?? buildSessionSnapshot(settings)),memory:settings.memory };
    const startedAt = new Date();
    const created = await transaction(async (client) => {
      if (input.data.registrationRequestId) {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`edulab:registration:${experimentId}:${input.data.registrationRequestId}`]);
        const prior = await client.query<{id:string;external_code:string;metadata:{registration_run_id?:string}}>(
          "SELECT id,external_code,metadata FROM participants WHERE experiment_id=$1 AND metadata->>'registration_request_id'=$2 FOR UPDATE",
          [experimentId,input.data.registrationRequestId]);
        if (prior.rows[0]) {
          const participant = prior.rows[0];
          if (entry?.assignmentMode === "roster") {
            const match = await client.query("SELECT 1 FROM roster_entries WHERE experiment_run_id=$1 AND participant_id=$2 AND class_name=$3",[entry.runId,participant.id,input.data.rosterClass ?? ""]);
            if(!match.rowCount) throw new ApiError(409,"REGISTRATION_ALREADY_USED","报名信息不一致，请使用原编号恢复。");
          }
          const profileRows = await client.query("SELECT * FROM participant_identity_profiles WHERE participant_id=$1", [participant.id]);
          const profile = profileRows.rows[0] ? profileFromRow(profileRows.rows[0]) : null;
          if (!profile || !input.data.profile || profile.fullName.trim()!==input.data.profile.fullName
            || profile.studentNumber.trim()!==input.data.profile.studentNumber || (participant.metadata.registration_run_id ?? null)!==(entry?.runId ?? null)) {
            throw new ApiError(409,"REGISTRATION_ALREADY_USED","此报名请求已使用，请通过原分组链接，使用原编号和姓名或学号继续实验。");
          }
          const row = (await client.query(`SELECT * FROM experiment_sessions WHERE participant_id=$1 AND experiment_id=$2
            AND experiment_run_id IS NOT DISTINCT FROM $3::uuid ORDER BY (status='active') DESC,started_at DESC,id DESC LIMIT 1 FOR UPDATE`,
          [participant.id,experimentId,entry?.runId ?? null])).rows[0];
          if (!row) throw new ApiError(409,"REGISTRATION_INCOMPLETE","已有报名记录缺少会话，请联系教师，系统不会重复报名。");
          const secretHash = hashSecret(secret);
          await client.query(`UPDATE experiment_sessions SET session_secret_hash=$3 WHERE participant_id=$1 AND experiment_id=$2
            AND experiment_run_id IS NOT DISTINCT FROM $4::uuid`, [participant.id,experimentId,secretHash,entry?.runId ?? null]);
          const resumed: AuthenticatedSession = {id:row.id,publicId:row.public_id,participantId:participant.id,
            participantCode:participant.external_code,experimentId,status:row.status,cozeUserId:row.coze_user_id,
            cozeConversationId:row.coze_conversation_id,difyConversationId:row.dify_conversation_id,
            activeRequestId:row.active_request_id,startedAt:row.started_at,lastActivityAt:row.last_activity_at,
            configVersion:row.config_version,configSnapshot:row.config_snapshot,sessionSecretHash:secretHash};
          return {resumed};
        }
      }
      let participantId: string;
      let participantCode: string;
      let rosterEntryId: string | null = null;
      if (entry?.assignmentMode === "roster") {
        if(requestedParticipantCode || !input.data.profile || !input.data.rosterClass) throw new ApiError(400,"ROSTER_IDENTITY_REQUIRED","请选择班级并填写名单中的参与姓名。");
        if(input.data.profile.studentNumber) throw new ApiError(400,"ROSTER_IDENTITY_REQUIRED","名单入口使用班级和参与姓名，不需要学号。");
        rosterEntryId=await claimRosterEntry(client,entry.runId,input.data.rosterClass,input.data.profile.fullName);
      }
      const registration = input.data.registrationRequestId ? {registration_request_id:input.data.registrationRequestId,registration_run_id:entry?.runId ?? null} : {};
      if (requestedParticipantCode) {
        const participant = await client.query<{ id: string }>(
          `INSERT INTO participants (id, experiment_id, external_code, metadata) VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (experiment_id, external_code) DO NOTHING
           RETURNING id`,
          [randomUUID(), experimentId, requestedParticipantCode,JSON.stringify(registration)],
        );
        if (!participant.rows[0]) throw new ApiError(409, "PARTICIPANT_EXISTS", "此编号已有实验记录，请选择继续之前的实验，系统不会创建重复记录。");
        participantId = participant.rows[0].id;
        participantCode = requestedParticipantCode;
      } else {
        participantId = randomUUID();
        participantCode = `__pending_${participantId}`;
        // Uncommitted placeholder permits profile/assignment work in parallel.
        // The final P/T code is allocated immediately before COMMIT.
        await client.query(`INSERT INTO participants (id, experiment_id, external_code,metadata) VALUES ($1,$2,$3,$4::jsonb)`,
          [participantId, experimentId, participantCode,JSON.stringify(registration)]);
      }
      let profile: ParticipantProfile | null = null;
      if (input.data.profile) {
        profile = await saveParticipantProfileWithClient(
          client,
          participantId,
          input.data.profile.fullName,
          input.data.profile.studentNumber,
        );
      }
      if(rosterEntryId) await client.query("UPDATE roster_entries SET participant_id=$2 WHERE id=$1",[rosterEntryId,participantId]);
      const assignedAgent = await assignAgentWithClient(client, experimentId, participantId, entry?.runId);
      const snapshot = {
        ...baseSnapshot,
        ai: {
          provider: assignedAgent.provider,
          baseUrl: assignedAgent.baseUrl,
          botId: assignedAgent.botId,
          agentId: assignedAgent.agentId,
          runId: assignedAgent.runId,
          internalName: assignedAgent.internalName,
        },
      };
      await client.query(
        `INSERT INTO experiment_sessions (id, public_id, participant_id, experiment_id, session_secret_hash,
           coze_user_id, config_version, config_snapshot, started_at, last_activity_at, metadata,
           experiment_run_id, agent_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9,
           jsonb_build_object('conversation_title','新对话','transcript_authority','server','interaction_id',($1::uuid)::text), $10, $11)`,
        [sessionId, publicId, participantId, experimentId, hashSecret(secret),
          `edulab_${publicId.replaceAll("-", "")}`, snapshot.version, JSON.stringify(snapshot), startedAt,
          assignedAgent.runId, assignedAgent.agentId],
      );
      await captureSessionMemory(client,{id:sessionId,participantId,experimentId,configSnapshot:snapshot});
      if (!requestedParticipantCode) {
        const codePrefix = isTestParticipantName(input.data.profile?.fullName ?? "") ? "T" : "P";
        const numbered = await createParticipantWithAvailableCode(client, experimentId, codePrefix, participantId);
        participantCode = numbered.participantCode;
      }
      return { participantId, participantCode, assignedAgent, snapshot, profile };
    });

    if (created.resumed) {
      const response = NextResponse.json(await buildSessionPayload(created.resumed));
      response.cookies.set(sessionCookieName(entry),`${created.resumed.publicId}.${secret}`,{
        httpOnly:true,sameSite:"lax",secure:process.env.NODE_ENV==="production",path:"/",maxAge:60*60*8,
      });
      return response;
    }

    const endsAt = created.snapshot.limits.sessionDurationMinutes
      ? new Date(startedAt.getTime() + created.snapshot.limits.sessionDurationMinutes * 60_000).toISOString()
      : null;

    const profile = created.profile;

    const response = NextResponse.json({
      session: { id: publicId, status: "active", startedAt: startedAt.toISOString(), lastActivityAt: startedAt.toISOString(), participantCode: created.participantCode, cozeConversationId: null, provider: created.assignedAgent.provider, difyConversationId: null, experimentRunId: created.assignedAgent.runId, agentId: created.assignedAgent.agentId },
      experiment: created.snapshot.experiment,
      draft: { text: "", revision: 0 }, messages: [], participantProfile: profile, pending: false, failedRequest: null,
      controls: {
        taskVisible: created.snapshot.experiment.taskVisible, chatEnabled: created.snapshot.experiment.chatEnabled,
        maxMessageChars: created.snapshot.limits.maxMessageChars, maxUserMessages: created.snapshot.limits.maxUserMessages,
        usedMessages: 0, remainingMessages: created.snapshot.limits.maxUserMessages, endsAt,
        databaseMessagesEnabled: created.snapshot.storage.databaseMessagesEnabled,
      },
    }, { status: 201 });
    response.cookies.set(sessionCookieName(entry), `${publicId}.${secret}`, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: 60 * 60 * 8,
    });
    if (!entry) clearRuntimeCookie(response);
    return response;
  } catch (error) {
    if (error instanceof Error && error.message === "NO_ACTIVE_EXPERIMENT_RUN") return errorResponse(new ApiError(409, error.message, "此入口未开放新报名，请联系教师；已有记录可使用恢复入口。"));
    return errorResponse(error);
  }
}
