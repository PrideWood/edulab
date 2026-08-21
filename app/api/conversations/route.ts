import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query, transaction } from "@/db";
import { buildSessionSnapshot, getExperimentSettings, type ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import { ApiError, errorResponse } from "@/lib/http";
import { getSessionControls } from "@/lib/experiment-limits";
import { getAuthenticatedSession, type AuthenticatedSession } from "@/lib/session";
import { buildSessionPayload } from "@/lib/session-payload";
import { parseSessionCookie, SESSION_COOKIE } from "@/lib/security";

const inputSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create") }),
  z.object({ action: z.literal("switch"), sessionId: z.uuid() }),
]);

interface SessionRow {
  id: string; public_id: string; participant_id: string; experiment_id: string;
  status: "active" | "completed"; coze_user_id: string; coze_conversation_id: string | null;
  active_request_id: string | null; started_at: string; last_activity_at: string;
  config_version: number | null; config_snapshot: ExperimentSessionSnapshot | null;
  session_secret_hash: string;
}

function authenticatedFromRow(row: SessionRow, participantCode: string): AuthenticatedSession {
  return {
    id: row.id, publicId: row.public_id, participantId: row.participant_id,
    participantCode, experimentId: row.experiment_id, status: row.status,
    cozeUserId: row.coze_user_id, cozeConversationId: row.coze_conversation_id,
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
     WHERE participant_id = $1 AND experiment_id = $2 AND session_secret_hash = $3
     ORDER BY last_activity_at DESC`,
    [session.participantId, session.experimentId, session.sessionSecretHash],
  );
  return result.rows.map((row) => ({
    id: row.public_id, title: row.title, status: row.status,
    startedAt: row.started_at, lastActivityAt: row.last_activity_at,
  }));
}

function setSessionCookie(response: NextResponse, publicId: string, secret: string) {
  response.cookies.set(SESSION_COOKIE, `${publicId}.${secret}`, {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production",
    path: "/", maxAge: 60 * 60 * 8,
  });
}

export async function GET() {
  try {
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    return NextResponse.json({ conversations: await listConversations(session), currentSessionId: session.publicId });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const current = await getAuthenticatedSession();
    if (!current) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const parsedCookie = parseSessionCookie((await cookies()).get(SESSION_COOKIE)?.value);
    if (!parsedCookie) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_CONVERSATION_ACTION", "对话操作无效。");

    let target: AuthenticatedSession;
    if (input.data.action === "create") {
      const controls = await getSessionControls(current);
      if (!controls.controls.chatEnabled) throw new ApiError(403, "CHAT_DISABLED", "本次实验未开放 AI 对话。");
      if (controls.controls.remainingMessages === 0) throw new ApiError(409, "MESSAGE_LIMIT_REACHED", "已经达到本次实验允许的交流次数。");
      if (controls.controls.endsAt && new Date(controls.controls.endsAt).getTime() <= Date.now()) throw new ApiError(409, "TIME_LIMIT_REACHED", "本次实验的交流时间已经结束。");
      const snapshot = current.configSnapshot ?? buildSessionSnapshot(await getExperimentSettings(current.experimentId));
      const now = new Date();
      const row = await transaction(async (client) => {
        const id = randomUUID();
        const publicId = randomUUID();
        const inserted = await client.query<SessionRow>(
          `INSERT INTO experiment_sessions (id, public_id, participant_id, experiment_id, session_secret_hash,
             coze_user_id, config_version, config_snapshot, started_at, last_activity_at, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$9,'{"conversation_title":"新对话"}'::jsonb)
           RETURNING id, public_id, participant_id, experiment_id, status, coze_user_id,
             coze_conversation_id, active_request_id, started_at, last_activity_at,
             config_version, config_snapshot, session_secret_hash`,
          [id, publicId, current.participantId, current.experimentId, current.sessionSecretHash,
            `edulab_${publicId.replaceAll("-", "")}`, snapshot.version, JSON.stringify(snapshot), now],
        );
        return inserted.rows[0];
      });
      target = authenticatedFromRow(row, current.participantCode);
    } else {
      const result = await query<SessionRow>(
        `SELECT id, public_id, participant_id, experiment_id, status, coze_user_id,
           coze_conversation_id, active_request_id, started_at, last_activity_at,
           config_version, config_snapshot, session_secret_hash
         FROM experiment_sessions
         WHERE public_id = $1 AND participant_id = $2 AND experiment_id = $3 AND session_secret_hash = $4`,
        [input.data.sessionId, current.participantId, current.experimentId, current.sessionSecretHash],
      );
      if (!result.rows[0]) throw new ApiError(404, "CONVERSATION_NOT_FOUND", "找不到这个对话。");
      target = authenticatedFromRow(result.rows[0], current.participantCode);
    }

    const response = NextResponse.json({
      payload: await buildSessionPayload(target),
      conversations: await listConversations(target),
    });
    setSessionCookie(response, target.publicId, parsedCookie.secret);
    return response;
  } catch (error) { return errorResponse(error); }
}
