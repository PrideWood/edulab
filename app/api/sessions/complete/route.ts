import { NextResponse } from "next/server";
import { transaction } from "@/db";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getSessionControls } from "@/lib/experiment-limits";
import { ApiError, errorResponse } from "@/lib/http";
import { getAuthenticatedSession } from "@/lib/session";
import { buildSessionPayload } from "@/lib/session-payload";
import { persistTranscript, transcriptInputSchema } from "@/lib/transcript";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    if (session.activeRequestId) throw new ApiError(409, "SESSION_BUSY", "请等待 AI 完成本次回复后再整理记录。");
    const input = transcriptInputSchema.safeParse(await request.json().catch(() => ({ messages: [] })));
    if (!input.success) throw new ApiError(400, "INVALID_TRANSCRIPT", input.error.issues[0]?.message ?? "本地对话记录格式无效。");
    const state = await getSessionControls(session);

    const completedAt = await transaction(async (client) => {
      if (state.controls.databaseMessagesEnabled) {
        await persistTranscript(client, session.id, input.data.messages, {
          requireComplete: true,
          storageMode: "automatic_completion",
        });
      }
      const result = await client.query<{ completed_at: string }>(
        `UPDATE experiment_sessions SET status = 'completed', completed_at = COALESCE(completed_at, now()), last_activity_at = now(),
           metadata = metadata || $2::jsonb
         WHERE id = $1 AND active_request_id IS NULL RETURNING completed_at`,
        [session.id, JSON.stringify({
          transcript_storage: state.controls.databaseMessagesEnabled ? "database_background_and_completion" : "browser_export_only",
          transcript_message_count: input.data.messages.length,
          transcript_turn_count: new Set(input.data.messages.map((message) => message.turnIndex)).size,
          completion_source: "configured_limit",
        })],
      );
      if (!result.rows[0]) throw new ApiError(409, "SESSION_BUSY", "请等待 AI 完成本次回复后再整理记录。");
      return result.rows[0].completed_at;
    });

    return NextResponse.json(await buildSessionPayload({
      ...session,
      status: "completed",
      activeRequestId: null,
      lastActivityAt: completedAt,
    }));
  } catch (error) { return errorResponse(error); }
}
