import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { recoverParticipant } from "@/lib/participant-recovery";
import { clearRuntimeCookie } from "@/lib/runtime-session";
import { SESSION_COOKIE } from "@/lib/security";

export const runtime = "nodejs";
const inputSchema = z.object({ participantCode: z.string().trim().min(1).max(80), identity: z.string().trim().min(1).max(100) });

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_RECOVERY", "请输入实验编号及身份校验信息。");
    const recovered = await recoverParticipant(input.data.participantCode, input.data.identity);
    // Issue the credential even if provider recovery temporarily fails. The
    // browser can retry GET without another rotation or participant creation.
    const response = NextResponse.json({ resumed: true }, { headers: { "Cache-Control": "private, no-store" } });
    response.cookies.set(SESSION_COOKIE, `${recovered.session.publicId}.${recovered.secret}`, {
      httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 8,
    });
    clearRuntimeCookie(response);
    return response;
  } catch (error) { return errorResponse(error); }
}
