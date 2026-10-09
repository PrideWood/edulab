import { NextResponse } from "next/server";
import { z } from "zod";
import { beginChatRequest, CozeChatError, createCozeChat, finalizeCompletedRequest, formatCozeError, getUnstoredCompletedRequestMessages, markRequestFailed, recoverPendingRequest, waitForCozeChat } from "@/lib/coze";
import type { StoredMessage } from "@/db/schema";
import { ApiError, errorResponse } from "@/lib/http";
import { getLatestFailedRequest, listMessages, mergeStoredMessages } from "@/lib/messages";
import { getParticipantProfile } from "@/lib/participant-profile";
import { getAuthenticatedSession } from "@/lib/session";
import { assertSessionCanSend, getSessionControls } from "@/lib/experiment-limits";
import { assertSameOrigin } from "@/lib/admin-auth";
import { importLegacyRuntime } from "@/lib/legacy-runtime";
import { getSessionDraft } from "@/lib/session-draft";

export const runtime = "nodejs";
export const maxDuration = 60;

const inputSchema = z.object({
  clientRequestId: z.uuid(),
  content: z.string().trim().min(1).max(20_000),
  turnIndex: z.number().int().positive().max(2000).optional(),
  userSequence: z.number().int().positive().max(10_000).optional(),
});

async function responsePayload(
  session: NonNullable<Awaited<ReturnType<typeof getAuthenticatedSession>>>,
  pending: boolean,
  transientMessages: StoredMessage[] = [],
  cozeConversationId: string | null = session.cozeConversationId,
) {
  const state = await getSessionControls(session);
  const storedMessages = await listMessages(session.id);
  const messages = mergeStoredMessages(storedMessages, transientMessages);
  return {
    session: { id: session.publicId, status: state.status, startedAt: session.startedAt, lastActivityAt: new Date().toISOString(), participantCode: session.participantCode, cozeConversationId, experimentRunId: session.configSnapshot?.ai.runId ?? null, agentId: session.configSnapshot?.ai.agentId ?? null },
    experiment: state.snapshot.experiment,
    draft: await getSessionDraft(session.id),
    messages, participantProfile: await getParticipantProfile(session.participantId), pending,
    failedRequest: pending ? null : await getLatestFailedRequest(session.id),
    controls: state.controls,
  };
}

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof getAuthenticatedSession>> = null;
  let requestId: string | null = null;
  try {
    assertSameOrigin(request);
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_MESSAGE", "消息为空或过长，请修改后重试。");
    session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效，请重新打开实验链接。");
    await importLegacyRuntime(session);
    if (session.status !== "active") throw new ApiError(409, "SESSION_COMPLETED", "本次实验已经结束，不能再发送消息。");
    const state = await assertSessionCanSend(session, input.data.content);
    const databaseMessagesEnabled = state.controls.databaseMessagesEnabled;

    let begun;
    try { begun = await beginChatRequest(session, input.data.clientRequestId, input.data.content, databaseMessagesEnabled); }
    catch (error) {
      if ((error as { code?: string }).code === "EXPERIMENT_LIMIT_REACHED") throw new ApiError(409, "EXPERIMENT_LIMIT_REACHED", "本次实验已达到交流限制。");
      if ((error as { code?: string }).code === "SESSION_BUSY") throw new ApiError(409, "SESSION_BUSY", "上一条消息仍在处理中，请稍候。");
      throw error;
    }
    requestId = begun.request.id;

    if (!begun.created) {
      if (begun.request.status === "completed") {
        const recovered = await getUnstoredCompletedRequestMessages(session, begun.request);
        return NextResponse.json(await responsePayload(session, false, recovered, begun.request.cozeConversationId));
      }
      if (begun.request.status === "failed" || begun.request.status === "uncertain") throw new ApiError(409, "REQUEST_FAILED", "这次发送未完成，请使用重试按钮重新发送。");
      const recovery = await recoverPendingRequest(session);
      return NextResponse.json(await responsePayload(session, recovery.pending, recovery.messages, begun.request.cozeConversationId), { status: recovery.pending ? 202 : 200 });
    }

    let chat;
    try { chat = await createCozeChat(session, requestId, input.data.clientRequestId, input.data.content); }
    catch (error) {
      await markRequestFailed(session.id, requestId, "COZE_CREATE_UNCERTAIN", error instanceof Error ? error.message : "Coze request failed", "uncertain");
      throw new ApiError(502, "COZE_UNAVAILABLE", databaseMessagesEnabled
        ? "AI 请求结果暂时无法确认，你的消息已保存。请核对恢复提示，暂勿重复发送。"
        : "AI 请求结果暂时无法确认，请保留本地记录并联系教师，暂勿重复发送。");
    }

    let result;
    try { result = await waitForCozeChat(session, chat, 1000); }
    catch (error) {
      console.error("Coze polling was interrupted; the request remains recoverable", error);
      return NextResponse.json(await responsePayload(session, true, [], chat.conversation_id), { status: 202 });
    }
    if (result.pending) return NextResponse.json(await responsePayload(session, true, [], result.chat.conversation_id), { status: 202 });
    const completedMessages = await finalizeCompletedRequest(session.id, requestId, result.chat, result.messages, {
      content: input.data.content,
      clientRequestId: input.data.clientRequestId,
    });
    return NextResponse.json(await responsePayload(session, false, completedMessages, result.chat.conversation_id));
  } catch (error) {
    if (error instanceof CozeChatError) {
      return errorResponse(new ApiError(502, "COZE_FAILED", formatCozeError(error)));
    }
    // Persisted provider IDs remain recoverable after polling/finalization or DB errors.
    // Never mark an uncertain finalization failed: GET must be able to retry it.
    return errorResponse(error);
  }
}
