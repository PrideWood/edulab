import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { transaction } from "@/db";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getSessionControls } from "@/lib/experiment-limits";
import { ApiError, errorResponse } from "@/lib/http";
import { getAuthenticatedSession } from "@/lib/session";
import { SESSION_COOKIE } from "@/lib/security";
import { clearRuntimeCookie, getRuntimeSession } from "@/lib/runtime-session";
import { persistTranscript, transcriptInputSchema } from "@/lib/transcript";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const runtime = await getRuntimeSession();
    const session = await getAuthenticatedSession();
    if (!session) {
      const hasSessionCookie = Boolean((await cookies()).get(SESSION_COOKIE)?.value);
      if (!runtime && !hasSessionCookie) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
      const orphanedResponse = NextResponse.json({ reset: true, orphaned: true, databaseMessagesSaved: false });
      orphanedResponse.cookies.set(SESSION_COOKIE, "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      });
      clearRuntimeCookie(orphanedResponse);
      return orphanedResponse;
    }
    const input = transcriptInputSchema.safeParse(await request.json().catch(() => ({ messages: [] })));
    if (!input.success) throw new ApiError(400, "INVALID_TRANSCRIPT", input.error.issues[0]?.message ?? "本地对话记录格式无效。");
    const state = await getSessionControls(session);

    await transaction(async (client) => {
      const busy = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM experiment_sessions
           WHERE participant_id = $1 AND experiment_id = $2 AND session_secret_hash = $3
             AND active_request_id IS NOT NULL
         ) AS exists`,
        [session.participantId, session.experimentId, session.sessionSecretHash],
      );
      if (busy.rows[0]?.exists) throw new ApiError(409, "SESSION_BUSY", "请等待 AI 完成本次回复后再切换参与者。");

      if (state.controls.databaseMessagesEnabled) {
        await persistTranscript(client, session.id, input.data.messages, {
          requireComplete: true,
          storageMode: "participant_switch",
        });
      }

      await client.query(
        `UPDATE experiment_sessions
         SET status = 'completed', completed_at = COALESCE(completed_at, now()), last_activity_at = now(),
           metadata = metadata || $4::jsonb
         WHERE participant_id = $1 AND experiment_id = $2 AND session_secret_hash = $3
           AND status = 'active' AND active_request_id IS NULL`,
        [session.participantId, session.experimentId, session.sessionSecretHash, JSON.stringify({
          end_reason: "participant_switch",
          completion_source: "student_device_switch",
          transcript_storage: state.controls.databaseMessagesEnabled ? "database_participant_switch" : "browser_archive_only",
        })],
      );
    });

    const response = NextResponse.json({ reset: true, databaseMessagesSaved: state.controls.databaseMessagesEnabled });
    response.cookies.set(SESSION_COOKIE, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
    clearRuntimeCookie(response);
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
