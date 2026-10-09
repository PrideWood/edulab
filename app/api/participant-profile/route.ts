import { getStudentEntry } from "@/lib/experiment-entry";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { getParticipantProfile, saveParticipantProfileWithClient } from "@/lib/participant-profile";
import { getAuthenticatedSession } from "@/lib/session";
import { sessionTransaction } from "@/lib/session-write";

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

export async function GET(request?: Request) {
  try {
    const session = await getAuthenticatedSession(await getStudentEntry(request));
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    return noStoreJson({ profile: await getParticipantProfile(session.participantId) });
  } catch (error) { return errorResponse(error); }
}

export async function PUT(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getAuthenticatedSession(await getStudentEntry(request));
    if (!session) throw new ApiError(401, "SESSION_REQUIRED", "实验会话已失效。");
    const input = inputSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_PARTICIPANT_PROFILE", input.error.issues[0]?.message ?? "参与者信息无效。");
    const existing = await getParticipantProfile(session.participantId);
    if (!input.data.studentNumber && (!existing || existing.studentNumber)) throw new ApiError(400,"STUDENT_NUMBER_REQUIRED","请填写学号，姓名可以不填。");
    const profile = await sessionTransaction(session, (client) => saveParticipantProfileWithClient(client, session.participantId, input.data.fullName, input.data.studentNumber));
    const response = noStoreJson({ profile });
    return response;
  } catch (error) { return errorResponse(error); }
}
