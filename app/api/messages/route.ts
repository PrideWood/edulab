import { NextResponse } from "next/server";
import { z } from "zod";
import { beginChatRequest, CozeChatError, createCozeChat, finalizeCompletedRequest, formatCozeError, getUnstoredCompletedRequestMessages, markRequestFailed, recoverPendingRequest, runCozeChatWithoutDatabase, waitForCozeChat } from "@/lib/coze";
import type { StoredMessage } from "@/db/schema";
import { ApiError, errorResponse } from "@/lib/http";
import { getLatestFailedRequest, listMessages, mergeStoredMessages } from "@/lib/messages";
import { getParticipantProfile } from "@/lib/participant-profile";
import { getAuthenticatedSession } from "@/lib/session";
import { assertSessionCanSend, getSessionControls } from "@/lib/experiment-limits";
import { getRuntimeControls, getRuntimeSession, setRuntimeCookie, type RuntimeSessionContext } from "@/lib/runtime-session";

export const runtime = "nodejs";
export const maxDuration = 60;

const inputSchema = z.object({
  clientRequestId: z.uuid(),
  content: z.string().trim().min(1).max(20_000),
  turnIndex: z.number().int().positive().max(2000).optional(),
  userSequence: z.number().int().positive().max(10_000).optional(),
});

function runtimePayload(context: RuntimeSessionContext, pending: boolean, messages: StoredMessage[] = []) {
  return {
    session: {
      id: context.session.publicId,
      status: context.session.status,
      startedAt: context.session.startedAt,
      lastActivityAt: context.session.lastActivityAt,
      participantCode: context.session.participantCode,
      cozeConversationId: context.session.cozeConversationId,
      experimentRunId: context.agent.runId,
      agentId: context.agent.agentId,
    },
    messages,
    participantProfile: context.profile,
    pending,
    failedRequest: null,
    controls: getRuntimeControls(context),
  };
}

async function postWithoutDatabase(context: RuntimeSessionContext, input: z.infer<typeof inputSchema>) {
  const controls = getRuntimeControls(context);
  if (!context.profile) throw new ApiError(409, "PARTICIPANT_PROFILE_REQUIRED", "请先填写参与者信息。");
  if (context.session.status !== "active") throw new ApiError(409, "SESSION_COMPLETED", "本次实验已经结束，不能再发送消息。");
  if (!controls.chatEnabled) throw new ApiError(403, "CHAT_DISABLED", "本次实验未开放 AI 对话。");
  if (controls.endsAt && Date.parse(controls.endsAt) <= Date.now()) throw new ApiError(409, "TIME_LIMIT_REACHED", "本次实验的交流时间已结束。");
  if (controls.remainingMessages !== null && controls.remainingMessages <= 0) throw new ApiError(409, "MESSAGE_LIMIT_REACHED", "你已经完成了本次实验允许的交流次数。");
  if (Array.from(input.content).length > controls.maxMessageChars) throw new ApiError(400, "MESSAGE_TOO_LONG", `每条消息最多 ${controls.maxMessageChars} 字。`);
  if (context.pendingRequest) throw new ApiError(409, "SESSION_BUSY", "上一条消息仍在处理中，请稍候。");

  const turnIndex = input.turnIndex ?? (context.conversationTurnCount ?? 0) + 1;
  const userSequence = input.userSequence ?? turnIndex * 2 - 1;
  const result = await runCozeChatWithoutDatabase({
    token: context.agent.token,
    baseUrl: context.agent.baseUrl,
    botId: context.agent.botId,
    cozeUserId: context.session.cozeUserId,
    cozeConversationId: context.session.cozeConversationId,
    sessionPublicId: context.session.publicId,
    clientRequestId: input.clientRequestId,
    content: input.content,
    turnIndex,
    userSequence,
  });
  const now = new Date().toISOString();
  const next: RuntimeSessionContext = {
    ...context,
    session: {
      ...context.session,
      cozeConversationId: result.chat.conversation_id,
      lastActivityAt: now,
    },
  };
  if (result.pending) {
    next.pendingRequest = {
      clientRequestId: input.clientRequestId,
      turnIndex,
      userSequence,
      chatId: result.chat.id,
      conversationId: result.chat.conversation_id,
      requestedAt: now,
    };
  } else {
    next.usedMessages = context.usedMessages + 1;
    next.conversationTurnCount = Math.max(context.conversationTurnCount ?? 0, turnIndex);
    delete next.pendingRequest;
  }
  const response = NextResponse.json(runtimePayload(next, result.pending, result.messages), { status: result.pending ? 202 : 200 });
  setRuntimeCookie(response, next);
  return response;
}

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
    messages, participantProfile: await getParticipantProfile(session.participantId), pending,
    failedRequest: pending ? null : await getLatestFailedRequest(session.id),
    controls: state.controls,
  };
}

export async function POST(request: Request) {
  let session: Awaited<ReturnType<typeof getAuthenticatedSession>> = null;
  let requestId: string | null = null;
  try {
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_MESSAGE", "消息为空或过长，请修改后重试。");
    const runtime = await getRuntimeSession();
    if (runtime) return await postWithoutDatabase(runtime, input.data);
    session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效，请重新打开实验链接。");
    if (session.status !== "active") throw new ApiError(409, "SESSION_COMPLETED", "本次实验已经结束，不能再发送消息。");
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
    if (error instanceof CozeChatError) {
      return errorResponse(new ApiError(502, "COZE_FAILED", formatCozeError(error)));
    }
    if (session && requestId && !(error instanceof ApiError)) {
      await markRequestFailed(session.id, requestId, "UNEXPECTED_ERROR", error instanceof Error ? error.message : "Unexpected error").catch(console.error);
    }
    return errorResponse(error);
  }
}
