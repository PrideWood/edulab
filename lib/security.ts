import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { experiment } from "@/config/experiment";

export const SESSION_COOKIE = "edulab_session";

export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function newSessionSecret() {
  return randomBytes(32).toString("base64url");
}

export function normalizeParticipantCode(code: string) {
  return code.trim().toUpperCase();
}

export function signParticipantCode(code: string) {
  const secret = process.env.PARTICIPANT_LINK_SECRET;
  if (!secret) throw new Error("PARTICIPANT_LINK_SECRET is not configured");
  return createHmac("sha256", secret).update(`${experiment.id}:${normalizeParticipantCode(code)}`).digest("base64url");
}

export function verifyParticipantAccess(code: string, signature: string | undefined) {
  if (process.env.NODE_ENV !== "production" && process.env.ALLOW_UNSIGNED_PARTICIPANTS === "true") return true;
  if (!signature) return false;
  const expected = Buffer.from(signParticipantCode(code));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export function parseSessionCookie(value: string | undefined) {
  if (!value) return null;
  const separator = value.indexOf(".");
  if (separator < 1) return null;
  const publicId = value.slice(0, separator);
  const secret = value.slice(separator + 1);
  if (!/^[0-9a-f-]{36}$/i.test(publicId) || secret.length < 32) return null;
  return { publicId, secret };
}
