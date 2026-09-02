import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { experiment } from "@/config/experiment";
import { transaction } from "@/db";
import { errorResponse, ApiError } from "@/lib/http";
import { getAuthenticatedSession } from "@/lib/session";
import { buildSessionPayload } from "@/lib/session-payload";
import { hashSecret, newSessionSecret, normalizeParticipantCode, SESSION_COOKIE, verifyParticipantAccess } from "@/lib/security";
import { buildSessionSnapshot, getExperimentSettings } from "@/lib/experiment-settings";
import { getParticipantProfile, saveParticipantProfileWithClient } from "@/lib/participant-profile";
import { assignAgentWithClient } from "@/lib/agent-control";
import { createRuntimeSession, getRuntimeControls, getRuntimeSession, setRuntimeCookie } from "@/lib/runtime-session";
import { CozeChatError, formatCozeError, recoverCozeChatWithoutDatabase } from "@/lib/coze";
import type { StoredMessage } from "@/db/schema";

export const runtime = "nodejs";

const profileSchema = z.object({
  fullName: z.string().trim().max(100),
  studentNumber: z.string().trim().max(100),
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

function formatParticipantCode(value: string | number) {
  return `P${String(value).padStart(3, "0")}`;
}

export async function GET() {
  try {
    const runtime = await getRuntimeSession();
    if (runtime) {
      let messages: StoredMessage[] = [];
      let pending = Boolean(runtime.pendingRequest);
      if (runtime.pendingRequest) {
        try {
          const recovered = await recoverCozeChatWithoutDatabase({
            token: runtime.agent.token,
            baseUrl: runtime.agent.baseUrl,
            ...runtime.pendingRequest,
          });
          pending = recovered.pending;
          messages = recovered.messages;
          runtime.session.cozeConversationId = recovered.chat.conversation_id;
          runtime.session.lastActivityAt = new Date().toISOString();
          if (!recovered.pending) {
            runtime.usedMessages += 1;
            runtime.conversationTurnCount = Math.max(runtime.conversationTurnCount ?? 0, runtime.pendingRequest.turnIndex);
            delete runtime.pendingRequest;
          }
        } catch (error) {
          delete runtime.pendingRequest;
          if (error instanceof CozeChatError) {
            const failed = NextResponse.json({ error: { code: "COZE_FAILED", message: formatCozeError(error) } }, { status: 502 });
            setRuntimeCookie(failed, runtime);
            return failed;
          }
          throw error;
        }
      }
      const response = NextResponse.json({
        session: {
          id: runtime.session.publicId,
          status: runtime.session.status,
          startedAt: runtime.session.startedAt,
          lastActivityAt: runtime.session.lastActivityAt,
          participantCode: runtime.session.participantCode,
          cozeConversationId: runtime.session.cozeConversationId,
          experimentRunId: runtime.agent.runId,
          agentId: runtime.agent.agentId,
        },
        messages,
        participantProfile: runtime.profile,
        pending,
        failedRequest: null,
        controls: getRuntimeControls(runtime),
      });
      if (runtime.pendingRequest || messages.length > 0) setRuntimeCookie(response, runtime);
      return response;
    }
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "请通过研究者提供的实验链接进入。 ");
    return NextResponse.json(await buildSessionPayload(session));
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
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_PARTICIPANT", "实验链接中的参与者信息无效。");
    const current = await getAuthenticatedSession();
    if (!input.data.participantCode && current?.experimentId === experiment.id) {
      return NextResponse.json(await buildSessionPayload(current));
    }
    const requestedParticipantCode = input.data.participantCode
      ? normalizeParticipantCode(input.data.participantCode)
      : null;
    if (current && current.experimentId === experiment.id && current.participantCode === requestedParticipantCode) {
      return NextResponse.json(await buildSessionPayload(current));
    }
    if (requestedParticipantCode && !verifyParticipantAccess(requestedParticipantCode, input.data.access)) {
      throw new ApiError(403, "INVALID_EXPERIMENT_LINK", "实验链接无效或已被修改，请使用研究者提供的完整链接。");
    }

    const secret = newSessionSecret();
    const publicId = randomUUID();
    const sessionId = randomUUID();
    const settings = await getExperimentSettings(experiment.id);
    const baseSnapshot = buildSessionSnapshot(settings);
    const startedAt = new Date();
    const created = await transaction(async (client) => {
      let participantId: string;
      let participantCode: string;
      if (requestedParticipantCode) {
        const participant = await client.query<{ id: string }>(
          `INSERT INTO participants (id, experiment_id, external_code) VALUES ($1, $2, $3)
           ON CONFLICT (experiment_id, external_code) DO UPDATE SET external_code = EXCLUDED.external_code
           RETURNING id`,
          [randomUUID(), experiment.id, requestedParticipantCode],
        );
        participantId = participant.rows[0].id;
        participantCode = requestedParticipantCode;
      } else {
        while (true) {
          const counter = await client.query<{ last_value: string }>(
            `INSERT INTO participant_code_counters (experiment_id, last_value) VALUES ($1, 1)
             ON CONFLICT (experiment_id) DO UPDATE SET
               last_value = participant_code_counters.last_value + 1,
               updated_at = now()
             RETURNING last_value`,
            [experiment.id],
          );
          participantCode = formatParticipantCode(counter.rows[0].last_value);
          const participant = await client.query<{ id: string }>(
            `INSERT INTO participants (id, experiment_id, external_code) VALUES ($1, $2, $3)
             ON CONFLICT (experiment_id, external_code) DO NOTHING
             RETURNING id`,
            [randomUUID(), experiment.id, participantCode],
          );
          if (participant.rows[0]) {
            participantId = participant.rows[0].id;
            break;
          }
        }
      }
      if (input.data.profile) {
        await saveParticipantProfileWithClient(
          client,
          participantId,
          input.data.profile.fullName,
          input.data.profile.studentNumber,
        );
      }
      const assignedAgent = await assignAgentWithClient(client, experiment.id, participantId);
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
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, '{"conversation_title":"新对话"}'::jsonb, $10, $11)`,
        [sessionId, publicId, participantId, experiment.id, hashSecret(secret),
          `edulab_${publicId.replaceAll("-", "")}`, settings.version, JSON.stringify(snapshot), startedAt,
          assignedAgent.runId, assignedAgent.agentId],
      );
      return { participantId, participantCode, assignedAgent, snapshot };
    });

    const endsAt = created.snapshot.limits.sessionDurationMinutes
      ? new Date(startedAt.getTime() + created.snapshot.limits.sessionDurationMinutes * 60_000).toISOString()
      : null;

    const profile = await getParticipantProfile(created.participantId);

    const response = NextResponse.json({
      session: { id: publicId, status: "active", startedAt: startedAt.toISOString(), lastActivityAt: startedAt.toISOString(), participantCode: created.participantCode, cozeConversationId: null, experimentRunId: created.assignedAgent.runId, agentId: created.assignedAgent.agentId },
      messages: [], participantProfile: profile, pending: false, failedRequest: null,
      controls: {
        taskVisible: created.snapshot.experiment.taskVisible, chatEnabled: created.snapshot.experiment.chatEnabled,
        maxMessageChars: created.snapshot.limits.maxMessageChars, maxUserMessages: created.snapshot.limits.maxUserMessages,
        usedMessages: 0, remainingMessages: created.snapshot.limits.maxUserMessages, endsAt,
        databaseMessagesEnabled: created.snapshot.storage.databaseMessagesEnabled,
      },
    }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, `${publicId}.${secret}`, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: 60 * 60 * 8,
    });
    setRuntimeCookie(response, createRuntimeSession({
      session: {
        id: sessionId, publicId, participantId: created.participantId,
        participantCode: created.participantCode, experimentId: experiment.id,
        status: "active", cozeUserId: `edulab_${publicId.replaceAll("-", "")}`,
        cozeConversationId: null, activeRequestId: null,
        startedAt: startedAt.toISOString(), lastActivityAt: startedAt.toISOString(),
        configVersion: settings.version, configSnapshot: created.snapshot,
        sessionSecretHash: hashSecret(secret),
      },
      profile,
      agent: created.assignedAgent,
    }));
    return response;
  } catch (error) { return errorResponse(error); }
}
