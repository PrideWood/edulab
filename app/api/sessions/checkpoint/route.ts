import { NextResponse } from "next/server";
import { query, transaction } from "@/db";
import type { ExperimentSessionSnapshot } from "@/lib/experiment-settings";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getSessionControls } from "@/lib/experiment-limits";
import { ApiError, errorResponse } from "@/lib/http";
import { getAuthenticatedSession } from "@/lib/session";
import { persistTranscript, transcriptInputSchema } from "@/lib/transcript";
import { getRuntimeSession } from "@/lib/runtime-session";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    let session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const input = transcriptInputSchema.safeParse(await request.json().catch(() => ({ messages: [] })));
    if (!input.success) throw new ApiError(400, "INVALID_TRANSCRIPT", input.error.issues[0]?.message ?? "本地对话记录格式无效。");
    if (input.data.sessionId && input.data.sessionId !== session.publicId) {
      const target = await query<{ id: string; public_id: string; status: "active" | "completed"; started_at: string; config_snapshot: ExperimentSessionSnapshot }>(
        `SELECT id, public_id, status, started_at, config_snapshot FROM experiment_sessions
         WHERE public_id=$1 AND participant_id=$2 AND experiment_id=$3 AND session_secret_hash=$4`,
        [input.data.sessionId, session.participantId, session.experimentId, session.sessionSecretHash]);
      if (!target.rows[0]) throw new ApiError(403, "INVALID_SESSION", "无权提交此对话的记录。");
      const row = target.rows[0];
      session = { ...session, id: row.id, publicId: row.public_id, status: row.status, startedAt: row.started_at, configSnapshot: row.config_snapshot };
    }
    const targetSession = session;
    const state = await getSessionControls(session);
    const runtime = await getRuntimeSession();
    if (state.controls.databaseMessagesEnabled && input.data.messages.length > 0) {
      await transaction(async (client) => {
        await persistTranscript(client, targetSession.id, input.data.messages, {
          requireComplete: false,
          storageMode: "background_checkpoint",
        });
        if (runtime?.session.publicId === targetSession.publicId && runtime.session.cozeConversationId) {
          await client.query(
            `UPDATE experiment_sessions SET coze_conversation_id = COALESCE(coze_conversation_id, $2), last_activity_at = now()
             WHERE id = $1`,
            [targetSession.id, runtime.session.cozeConversationId],
          );
        }
      });
    }
    return NextResponse.json({ saved: state.controls.databaseMessagesEnabled, messageCount: input.data.messages.length });
  } catch (error) { return errorResponse(error); }
}
