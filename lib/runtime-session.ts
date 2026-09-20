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
  lastCompletedRequest?: NonNullable<RuntimeSessionContext["pendingRequest"]>;
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
  return `v2.${[encrypted.iv, encrypted.tag, encrypted.ciphertext].map(value => Buffer.from(value, 'base64').toString('base64url')).join('.')}`;
}

function decodeContext(value: string): RuntimeSessionContext | null {
  try {
    const parts = value.split('.');
    const encrypted = parts[0] === 'v2' && parts.length === 4
      ? { iv: Buffer.from(parts[1], 'base64url').toString('base64'), tag: Buffer.from(parts[2], 'base64url').toString('base64'), ciphertext: Buffer.from(parts[3], 'base64url').toString('base64') }
      : JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as EncryptedSecret;
    const context = JSON.parse(decryptSecret(encrypted)) as RuntimeSessionContext;
    if (context.version !== 1 || !context.session?.publicId || !context.config || !context.agent?.botId || !context.agent?.token) return null;
    if (Date.parse(context.expiresAt) <= Date.now()) return null;
    return context;
  } catch {
    return null;
  }
}

export async function getRuntimeSession() {
  const jar = await cookies();
  let value = jar.get(RUNTIME_COOKIE)?.value ?? "";
  if (/^chunks:[1-3]$/.test(value)) {
    const count = Number(value.slice(7));
    value = Array.from({ length: count }, (_, i) => jar.get(`${RUNTIME_COOKIE}.${i}`)?.value ?? "").join("");
  }
  return decodeContext(value);
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
  const encoded = encodeContext(context);
  const chunks = encoded.match(/.{1,3500}/g) ?? [];
  if (chunks.length > 3) throw new Error("实验配置过大，无法安全保存浏览器会话。请缩短配置内容。");
  const options = {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: RUNTIME_MAX_AGE_SECONDS,
  };
  response.cookies.set(RUNTIME_COOKIE, chunks.length === 1 ? encoded : `chunks:${chunks.length}`, options);
  for (let i = 0; i < 3; i++) {
    const value = chunks.length > 1 ? chunks[i] : undefined;
    response.cookies.set(`${RUNTIME_COOKIE}.${i}`, value ?? "", { ...options, maxAge: value ? RUNTIME_MAX_AGE_SECONDS : 0 });
  }
}

export function clearRuntimeCookie(response: NextResponse) {
  for (let i = 0; i < 3; i++) response.cookies.set(`${RUNTIME_COOKIE}.${i}`, "", {
    httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0,
  });
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
