import "server-only";

import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import type { AssignedAgentRuntime } from "@/lib/agent-control";
import type { ParticipantProfile } from "@/lib/client-types";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "@/lib/secret-crypto";
import type { AuthenticatedSession } from "@/lib/session";
import type { SessionControls } from "@/lib/experiment-limits";

export const RUNTIME_COOKIE = "edulab_runtime";
const RUNTIME_MAX_AGE_SECONDS = 60 * 60 * 8;

export interface RuntimeSessionContext {
  version: 1;
  issuedAt: string;
  expiresAt: string;
  session: AuthenticatedSession;
  config: {
    taskVisible: boolean;
    chatEnabled: boolean;
    maxMessageChars: number;
    maxUserMessages: number | null;
    sessionDurationMinutes: number | null;
    databaseMessagesEnabled: boolean;
  };
  profile: ParticipantProfile | null;
  agent: AssignedAgentRuntime;
  usedMessages: number;
  conversationTurnCount: number;
  pendingRequest?: {
    clientRequestId: string;
    turnIndex: number;
    userSequence: number;
    chatId: string;
    conversationId: string;
    requestedAt: string;
  };
}

function encodeContext(context: RuntimeSessionContext) {
  const encrypted = encryptSecret(JSON.stringify(context));
  return Buffer.from(JSON.stringify(encrypted), "utf8").toString("base64url");
}

function decodeContext(value: string): RuntimeSessionContext | null {
  try {
    const encrypted = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as EncryptedSecret;
    const context = JSON.parse(decryptSecret(encrypted)) as RuntimeSessionContext;
    if (context.version !== 1 || !context.session?.publicId || !context.config || !context.agent?.botId || !context.agent?.token) return null;
    if (Date.parse(context.expiresAt) <= Date.now()) return null;
    return context;
  } catch {
    return null;
  }
}

export async function getRuntimeSession() {
  return decodeContext((await cookies()).get(RUNTIME_COOKIE)?.value ?? "");
}

export function createRuntimeSession(input: {
  session: AuthenticatedSession;
  profile: ParticipantProfile | null;
  agent: AssignedAgentRuntime;
  usedMessages?: number;
}): RuntimeSessionContext {
  const issuedAt = new Date();
  const snapshot = input.session.configSnapshot;
  if (!snapshot) throw new Error("Cannot create a runtime session without a configuration snapshot");
  return {
    version: 1,
    issuedAt: issuedAt.toISOString(),
    expiresAt: new Date(issuedAt.getTime() + RUNTIME_MAX_AGE_SECONDS * 1000).toISOString(),
    session: { ...input.session, configSnapshot: null },
    config: {
      taskVisible: snapshot.experiment.taskVisible,
      chatEnabled: snapshot.experiment.chatEnabled,
      maxMessageChars: snapshot.limits.maxMessageChars,
      maxUserMessages: snapshot.limits.maxUserMessages,
      sessionDurationMinutes: snapshot.limits.sessionDurationMinutes,
      databaseMessagesEnabled: snapshot.storage.databaseMessagesEnabled,
    },
    profile: input.profile,
    agent: input.agent,
    usedMessages: input.usedMessages ?? 0,
    conversationTurnCount: 0,
  };
}

export function setRuntimeCookie(response: NextResponse, context: RuntimeSessionContext) {
  response.cookies.set(RUNTIME_COOKIE, encodeContext(context), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: RUNTIME_MAX_AGE_SECONDS,
  });
}

export function clearRuntimeCookie(response: NextResponse) {
  response.cookies.set(RUNTIME_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export function getRuntimeControls(context: RuntimeSessionContext): SessionControls {
  const endsAt = context.config.sessionDurationMinutes
    ? new Date(new Date(context.session.startedAt).getTime() + context.config.sessionDurationMinutes * 60_000).toISOString()
    : null;
  const maximum = context.config.maxUserMessages;
  return {
    taskVisible: context.config.taskVisible,
    chatEnabled: context.config.chatEnabled,
    maxMessageChars: context.config.maxMessageChars,
    maxUserMessages: maximum,
    usedMessages: context.usedMessages,
    remainingMessages: maximum === null ? null : Math.max(0, maximum - context.usedMessages),
    endsAt,
    databaseMessagesEnabled: context.config.databaseMessagesEnabled,
  };
}
