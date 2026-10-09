import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getStudentEntry, sessionCookieName } from "@/lib/experiment-entry";
import { experiment } from "@/config/experiment";
import { transaction } from "@/db";
import { errorResponse, ApiError } from "@/lib/http";
import { getAuthenticatedSession } from "@/lib/session";
import { buildSessionPayload } from "@/lib/session-payload";
import { hashSecret, newSessionSecret, normalizeParticipantCode, verifyParticipantAccess } from "@/lib/security";
import { buildSessionSnapshot, getExperimentSettings } from "@/lib/experiment-settings";
import { getParticipantProfile, saveParticipantProfileWithClient } from "@/lib/participant-profile";
import { isTestParticipantName } from "@/lib/participant-code";
import { createParticipantWithAvailableCode } from "@/lib/participant-code-allocation";
import { assignAgentWithClient } from "@/lib/agent-control";
import { clearRuntimeCookie } from "@/lib/runtime-session";
import { assertSameOrigin } from "@/lib/admin-auth";
import { importLegacyRuntime } from "@/lib/legacy-runtime";

export const runtime = "nodejs";
export const maxDuration = 120;

const profileSchema = z.object({
  fullName: z.string().trim().max(100),
  studentNumber: z.string().trim().min(1, "请填写学号，姓名可以不填。").max(100),
}).refine((value) => value.fullName.length > 0 || value.studentNumber.length > 0, {
  message: "请至少填写姓名或学号中的一项。",
});

const inputSchema = z.object({
  participantCode: z.string().trim().min(1).max(80).optional(),
  access: z.string().max(200).optional(),
  profile: profileSchema.optional(),
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
    const baseSnapshot = entry?.snapshot ?? buildSessionSnapshot(settings);
    const startedAt = new Date();
    const created = await transaction(async (client) => {
      let participantId: string;
      let participantCode: string;
      if (requestedParticipantCode) {
        const participant = await client.query<{ id: string }>(
          `INSERT INTO participants (id, experiment_id, external_code) VALUES ($1, $2, $3)
           ON CONFLICT (experiment_id, external_code) DO NOTHING
           RETURNING id`,
          [randomUUID(), experimentId, requestedParticipantCode],
        );
        if (!participant.rows[0]) throw new ApiError(409, "PARTICIPANT_EXISTS", "此编号已有实验记录，请选择继续之前的实验，系统不会创建重复记录。");
        participantId = participant.rows[0].id;
        participantCode = requestedParticipantCode;
      } else {
        participantId = randomUUID();
        participantCode = `__pending_${participantId}`;
        // Uncommitted placeholder permits profile/assignment work in parallel.
        // The final P/T code is allocated immediately before COMMIT.
        await client.query(`INSERT INTO participants (id, experiment_id, external_code) VALUES ($1,$2,$3)`,
          [participantId, experimentId, participantCode]);
      }
      if (input.data.profile) {
        await saveParticipantProfileWithClient(
          client,
          participantId,
          input.data.profile.fullName,
          input.data.profile.studentNumber,
        );
      }
      const assignedAgent = await assignAgentWithClient(client, experimentId, participantId, entry?.runId);
      const snapshot = {
        ...baseSnapshot,
        ai: {
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, '{"conversation_title":"新对话","transcript_authority":"server"}'::jsonb, $10, $11)`,
        [sessionId, publicId, participantId, experimentId, hashSecret(secret),
          `edulab_${publicId.replaceAll("-", "")}`, snapshot.version, JSON.stringify(snapshot), startedAt,
          assignedAgent.runId, assignedAgent.agentId],
      );
      if (!requestedParticipantCode) {
        const codePrefix = isTestParticipantName(input.data.profile?.fullName ?? "") ? "T" : "P";
        const numbered = await createParticipantWithAvailableCode(client, experimentId, codePrefix, participantId);
        participantCode = numbered.participantCode;
      }
      return { participantId, participantCode, assignedAgent, snapshot };
    });

    const endsAt = created.snapshot.limits.sessionDurationMinutes
      ? new Date(startedAt.getTime() + created.snapshot.limits.sessionDurationMinutes * 60_000).toISOString()
      : null;

    const profile = await getParticipantProfile(created.participantId);

    const response = NextResponse.json({
      session: { id: publicId, status: "active", startedAt: startedAt.toISOString(), lastActivityAt: startedAt.toISOString(), participantCode: created.participantCode, cozeConversationId: null, experimentRunId: created.assignedAgent.runId, agentId: created.assignedAgent.agentId },
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
