import { NextResponse } from "next/server";
import { ADMIN_COOKIE, assertSameOrigin } from "@/lib/admin-auth";
import { errorResponse } from "@/lib/http";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const response = NextResponse.json({ ok: true });
    response.cookies.set(ADMIN_COOKIE, "", { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 0 });
    return response;
  } catch (error) { return errorResponse(error); }
}
