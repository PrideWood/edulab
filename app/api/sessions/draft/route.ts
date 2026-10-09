import { getStudentEntry } from "@/lib/experiment-entry";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { getAuthenticatedSession } from "@/lib/session";
import { sessionTransaction } from "@/lib/session-write";

const inputSchema = z.object({ sessionId: z.uuid(), text: z.string().max(20_000), revision: z.number().int().nonnegative() });
export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getAuthenticatedSession(await getStudentEntry(request));
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "会话失效，请使用编号恢复实验。");
    if (session.configSnapshot?.storage.databaseMessagesEnabled === false) throw new ApiError(409, "DRAFT_STORAGE_DISABLED", "本实验未开启云端内容存储，请保留本地输入。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success || input.data.sessionId !== session.publicId) throw new ApiError(400, "INVALID_DRAFT", "草稿会话信息无效。");
    const draft = await sessionTransaction(session, async (client) => {
      const result = await client.query<{ draft_revision: number }>(
        `UPDATE experiment_sessions SET draft_text=$2, draft_revision=draft_revision+1
         WHERE id=$1 AND draft_revision=$3 AND status='active' AND active_request_id IS NULL
         RETURNING draft_revision`, [session.id, input.data.text, input.data.revision],
      );
      if (!result.rows[0]) throw new ApiError(409, "DRAFT_CONFLICT", "草稿状态已变化，请保留输入并刷新核对，当前输入未保存到云端。");
      return { text: input.data.text, revision: result.rows[0].draft_revision };
    });
    return NextResponse.json({ draft });
  } catch (error) { return errorResponse(error); }
}

export const PUT = POST;
