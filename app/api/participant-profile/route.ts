import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { getParticipantProfile, saveParticipantProfile } from "@/lib/participant-profile";
import { getAuthenticatedSession } from "@/lib/session";
import { getRuntimeSession, setRuntimeCookie } from "@/lib/runtime-session";

export const runtime = "nodejs";

const inputSchema = z.object({
  fullName: z.string().trim().max(100),
  studentNumber: z.string().trim().max(100),
}).refine((value) => value.fullName.length > 0 || value.studentNumber.length > 0, {
  message: "请至少填写姓名或学号中的一项。",
});

function noStoreJson(body: unknown) {
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } });
}

export async function GET() {
  try {
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    return noStoreJson({ profile: await getParticipantProfile(session.participantId) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getAuthenticatedSession();
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_PARTICIPANT_PROFILE", input.error.issues[0]?.message ?? "参与者信息无效。");
    const profile = await saveParticipantProfile(session.participantId, input.data.fullName, input.data.studentNumber);
    const response = noStoreJson({ profile });
    const runtime = await getRuntimeSession();
    if (runtime && runtime.session.participantId === session.participantId) {
      runtime.profile = profile;
      setRuntimeCookie(response, runtime);
    }
    return response;
  } catch (error) { return errorResponse(error); }
}
