import { NextResponse } from "next/server";
import { z } from "zod";
import { ACCESS_COOKIE, ACCESS_COOKIE_MAX_AGE, createAccessCookieValue, verifySubmittedAccessCode } from "@/lib/access-code";
import { assertSameOrigin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";

export const runtime = "nodejs";

const inputSchema = z.object({
  accessCode: z.string().min(1).max(200),
});

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const configuredCode = process.env.ACCESS_CODE;
    if (!configuredCode) throw new ApiError(503, "ACCESS_CODE_NOT_CONFIGURED", "网站访问码尚未配置，请联系管理员。");

    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_ACCESS_CODE", "请输入访问码。");
    if (!(await verifySubmittedAccessCode(input.data.accessCode, configuredCode))) {
      await new Promise((resolve) => setTimeout(resolve, 350));
      throw new ApiError(401, "INVALID_ACCESS_CODE", "访问码不正确，请重新输入。");
    }

    const response = NextResponse.json({ verified: true });
    response.cookies.set(ACCESS_COOKIE, await createAccessCookieValue(configuredCode), {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: ACCESS_COOKIE_MAX_AGE,
    });
    return response;
  } catch (error) {
    return errorResponse(error);
  }
}
