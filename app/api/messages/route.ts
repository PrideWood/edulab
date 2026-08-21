import { NextResponse } from "next/server";
import { z } from "zod";
import { beginChatRequest, createCozeChat, finalizeCompletedRequest, getUnstoredCompletedRequestMessages, markRequestFailed, recoverPendingRequest, waitForCozeChat } from "@/lib/coze";
import type { StoredMessage } from "@/db/schema";
import { ApiError, errorResponse } from "@/lib/http";
import { getLatestFailedRequest, listMessages, mergeStoredMessages } from "@/lib/messages";
import { getParticipantProfile } from "@/lib/participant-profile";
import { getAuthenticatedSession } from "@/lib/session";
import { assertSessionCanSend, getSessionControls } from "@/lib/experiment-limits";

export const runtime = "nodejs";
export const maxDuration = 60;

const inputSchema = z.object({
  clientRequestId: z.uuid(),
  content: z.string().trim().min(1).max(20_000),
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
    session: { id: session.publicId, status: state.status, startedAt: session.startedAt, lastActivityAt: new Date().toISOString(), participantCode: session.participantCode, cozeConversationId },
    messages, participantProfile: await getParticipantProfile(session.participantId), pending,
    failedRequest: pending ? null : await getLatestFailedRequest(session.id),
    controls: state.controls,
  };
}

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof getAuthenticatedSession>> = null;
  let requestId: string | null = null;
  try {
    session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效，请重新打开实验链接。");
    if (session.status !== "active") throw new ApiError(409, "SESSION_COMPLETED", "本次实验已经结束，不能再发送消息。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_MESSAGE", "消息为空或过长，请修改后重试。");
    const state = await assertSessionCanSend(session, input.data.content);
    const databaseMessagesEnabled = state.controls.databaseMessagesEnabled;

    let begun;
    try { begun = await beginChatRequest(session, input.data.clientRequestId, input.data.content, databaseMessagesEnabled); }
    catch (error) {
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
      throw new ApiError(502, "COZE_UNAVAILABLE", "AI 暂时没有响应。你的消息已保存，可以稍后重试。");
    }

    let result;
    try { result = await waitForCozeChat(session, chat); }
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
    if (session && requestId && !(error instanceof ApiError)) {
      await markRequestFailed(session.id, requestId, "UNEXPECTED_ERROR", error instanceof Error ? error.message : "Unexpected error").catch(console.error);
    }
    return errorResponse(error);
  }
}
