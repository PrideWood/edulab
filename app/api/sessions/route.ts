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

export const runtime = "nodejs";

const inputSchema = z.object({
  participantCode: z.string().trim().min(1).max(80),
  access: z.string().max(200).optional(),
});

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
    const participantCode = normalizeParticipantCode(input.data.participantCode);
    const current = await getAuthenticatedSession();
    if (current && current.experimentId === experiment.id && current.participantCode === participantCode) {
      return NextResponse.json(await buildSessionPayload(current));
    }
    if (!verifyParticipantAccess(participantCode, input.data.access)) throw new ApiError(403, "INVALID_EXPERIMENT_LINK", "实验链接无效或已被修改，请使用研究者提供的完整链接。");

    const secret = newSessionSecret();
    const publicId = randomUUID();
    const sessionId = randomUUID();
    const settings = await getExperimentSettings(experiment.id);
    const snapshot = buildSessionSnapshot(settings);
    const startedAt = new Date();
    await transaction(async (client) => {
      const participant = await client.query<{ id: string }>(
        `INSERT INTO participants (id, experiment_id, external_code) VALUES ($1, $2, $3)
         ON CONFLICT (experiment_id, external_code) DO UPDATE SET external_code = EXCLUDED.external_code
         RETURNING id`,
        [randomUUID(), experiment.id, participantCode],
      );
      await client.query(
        `INSERT INTO experiment_sessions (id, public_id, participant_id, experiment_id, session_secret_hash,
           coze_user_id, config_version, config_snapshot, started_at, last_activity_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $9, '{"conversation_title":"新对话"}'::jsonb)`,
        [sessionId, publicId, participant.rows[0].id, experiment.id, hashSecret(secret),
          `edulab_${publicId.replaceAll("-", "")}`, settings.version, JSON.stringify(snapshot), startedAt],
      );
    });

    const endsAt = snapshot.limits.sessionDurationMinutes
      ? new Date(startedAt.getTime() + snapshot.limits.sessionDurationMinutes * 60_000).toISOString()
      : null;

    const response = NextResponse.json({
      session: { id: publicId, status: "active", startedAt: startedAt.toISOString(), lastActivityAt: startedAt.toISOString(), participantCode },
      messages: [], pending: false, failedRequest: null,
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
