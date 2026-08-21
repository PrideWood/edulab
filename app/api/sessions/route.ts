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
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "请通过研究者提供的实验链接进入。 ");
    return NextResponse.json(await buildSessionPayload(session));
  } catch (error) { return errorResponse(error); }
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
    const snapshot = buildSessionSnapshot(settings);
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
      await client.query(
        `INSERT INTO experiment_sessions (id, public_id, participant_id, experiment_id, session_secret_hash,
           coze_user_id, config_version, config_snapshot, started_at, last_activity_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, '{"conversation_title":"新对话"}'::jsonb)`,
        [sessionId, publicId, participantId, experiment.id, hashSecret(secret),
          `edulab_${publicId.replaceAll("-", "")}`, settings.version, JSON.stringify(snapshot), startedAt],
      );
      return { participantId, participantCode };
    });

    const endsAt = snapshot.limits.sessionDurationMinutes
      ? new Date(startedAt.getTime() + snapshot.limits.sessionDurationMinutes * 60_000).toISOString()
      : null;

    const response = NextResponse.json({
      session: { id: publicId, status: "active", startedAt: startedAt.toISOString(), lastActivityAt: startedAt.toISOString(), participantCode: created.participantCode, cozeConversationId: null },
      messages: [], participantProfile: await getParticipantProfile(created.participantId), pending: false, failedRequest: null,
      controls: {
        taskVisible: snapshot.experiment.taskVisible, chatEnabled: snapshot.experiment.chatEnabled,
        maxMessageChars: snapshot.limits.maxMessageChars, maxUserMessages: snapshot.limits.maxUserMessages,
        usedMessages: 0, remainingMessages: snapshot.limits.maxUserMessages, endsAt,
        databaseMessagesEnabled: snapshot.storage.databaseMessagesEnabled,
      },
    }, { status: 201 });
    response.cookies.set(SESSION_COOKIE, `${publicId}.${secret}`, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: 60 * 60 * 8,
    });
    return response;
  } catch (error) { return errorResponse(error); }
}
