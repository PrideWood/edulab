import "server-only";

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { query } from "@/db";
import { ApiError } from "@/lib/http";

export const ADMIN_COOKIE = "edulab_admin";
const SCRYPT_OPTIONS = { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
}

export function hashAdminPassword(password: string) {
  const salt = randomBytes(16);
  const derived = scryptSync(password, salt, 64, SCRYPT_OPTIONS);
  return `scrypt$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export function verifyAdminPassword(password: string, encoded: string) {
  const [scheme, saltText, hashText] = encoded.split("$");
  if (scheme !== "scrypt" || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const actual = scryptSync(password, Buffer.from(saltText, "base64url"), expected.length, SCRYPT_OPTIONS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function adminSessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32) throw new Error("ADMIN_SESSION_SECRET must contain at least 32 characters");
  return secret;
}

export function createAdminSessionToken(admin: AdminUser) {
  const payload = Buffer.from(JSON.stringify({ sub: admin.id, exp: Date.now() + 8 * 60 * 60_000, nonce: randomBytes(12).toString("base64url") })).toString("base64url");
  const signature = createHmac("sha256", adminSessionSecret()).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function verifyAdminSessionToken(token: string | undefined) {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(createHmac("sha256", adminSessionSecret()).update(payload).digest("base64url"));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { sub?: string; exp?: number };
    if (!parsed.sub || !parsed.exp || parsed.exp < Date.now()) return null;
    return parsed.sub;
  } catch { return null; }
}

export async function getAuthenticatedAdmin(): Promise<AdminUser | null> {
  const adminId = verifyAdminSessionToken((await cookies()).get(ADMIN_COOKIE)?.value);
  if (!adminId) return null;
  const result = await query<{ id: string; username: string; display_name: string }>(
    `SELECT id, username, display_name FROM admin_users WHERE id = $1 AND is_active = true`,
    [adminId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, username: row.username, displayName: row.display_name } : null;
}

export function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  if (!origin || origin !== new URL(request.url).origin) throw new ApiError(403, "INVALID_ORIGIN", "请求来源无效。");
}
