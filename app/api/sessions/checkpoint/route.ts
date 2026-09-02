import { NextResponse } from "next/server";
import { transaction } from "@/db";
import { assertSameOrigin } from "@/lib/admin-auth";
import { getSessionControls } from "@/lib/experiment-limits";
import { ApiError, errorResponse } from "@/lib/http";
import { getAuthenticatedSession } from "@/lib/session";
import { persistTranscript, transcriptInputSchema } from "@/lib/transcript";
import { getRuntimeSession } from "@/lib/runtime-session";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const input = transcriptInputSchema.safeParse(await request.json().catch(() => ({ messages: [] })));
    if (!input.success) throw new ApiError(400, "INVALID_TRANSCRIPT", input.error.issues[0]?.message ?? "本地对话记录格式无效。");
    const state = await getSessionControls(session);
    const runtime = await getRuntimeSession();
    if (state.controls.databaseMessagesEnabled && input.data.messages.length > 0) {
      await transaction(async (client) => {
        await persistTranscript(client, session.id, input.data.messages, {
          requireComplete: false,
          storageMode: "background_checkpoint",
        });
        if (runtime?.session.publicId === session.publicId && runtime.session.cozeConversationId) {
          await client.query(
            `UPDATE experiment_sessions SET coze_conversation_id = COALESCE(coze_conversation_id, $2), last_activity_at = now()
             WHERE id = $1`,
            [session.id, runtime.session.cozeConversationId],
          );
        }
      });
    }
    return NextResponse.json({ saved: state.controls.databaseMessagesEnabled, messageCount: input.data.messages.length });
  } catch (error) { return errorResponse(error); }
}
