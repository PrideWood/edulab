import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { query } from "@/db";
import { ADMIN_COOKIE, assertSameOrigin, createAdminSessionToken, verifyAdminPassword } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";

const inputSchema = z.object({
  username: z.string().trim().toLowerCase().min(2).max(64),
  password: z.string().min(8).max(256),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_LOGIN", "用户名或密码不正确。");
    const result = await query<{ id: string; username: string; display_name: string; password_hash: string; locked_until: Date | null }>(
      `SELECT id, username, display_name, password_hash, locked_until FROM admin_users
       WHERE username = $1 AND is_active = true`,
      [input.data.username],
    );
    const row = result.rows[0];
    const locked = row?.locked_until && row.locked_until.getTime() > Date.now();
    if (!row || locked || !verifyAdminPassword(input.data.password, row.password_hash)) {
      if (row && !locked) {
        await query(
          `UPDATE admin_users SET failed_login_count = failed_login_count + 1,
             locked_until = CASE WHEN failed_login_count + 1 >= 5 THEN now() + interval '15 minutes' ELSE locked_until END
           WHERE id = $1`,
          [row.id],
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 350));
      throw new ApiError(401, "INVALID_LOGIN", "用户名或密码不正确。");
    }
    const admin = { id: row.id, username: row.username, displayName: row.display_name };
    await query(`UPDATE admin_users SET last_login_at = now(), failed_login_count = 0, locked_until = NULL WHERE id = $1`, [row.id]);
    await query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action) VALUES ($1, $2, 'admin.login')`,
      [randomUUID(), row.id],
    );
    const response = NextResponse.json({ admin });
    response.cookies.set(ADMIN_COOKIE, createAdminSessionToken(admin), {
      httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production",
      path: "/", maxAge: 60 * 60 * 8,
    });
    return response;
  } catch (error) { return errorResponse(error); }
}
