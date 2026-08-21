import { NextRequest, NextResponse } from "next/server";
import { ACCESS_COOKIE, verifyAccessCookie } from "@/lib/access-code";

function apiError(status: number, code: string, message: string) {
  return NextResponse.json({ error: { code, message } }, { status });
}

export async function proxy(request: NextRequest) {
  const configuredCode = process.env.ACCESS_CODE;
  const isApiRequest = request.nextUrl.pathname.startsWith("/api/");

  if (!configuredCode) {
    if (isApiRequest) return apiError(503, "ACCESS_CODE_NOT_CONFIGURED", "网站访问码尚未配置。");
    const target = request.nextUrl.clone();
    target.pathname = "/access";
    target.search = "?configuration=missing";
    return NextResponse.redirect(target);
  }

  const verified = await verifyAccessCookie(request.cookies.get(ACCESS_COOKIE)?.value, configuredCode);
  if (verified) return NextResponse.next();
  if (isApiRequest) return apiError(401, "ACCESS_REQUIRED", "请先输入网站访问码。");

  const target = request.nextUrl.clone();
  const returnPath = `${request.nextUrl.pathname}${request.nextUrl.search}`;
  target.pathname = "/access";
  target.search = "";
  target.searchParams.set("next", returnPath);
  return NextResponse.redirect(target);
}

export const config = {
  matcher: [
    "/",
    "/api/sessions/:path*",
    "/api/messages/:path*",
    "/api/conversations/:path*",
    "/api/participant-profile/:path*",
  ],
};
