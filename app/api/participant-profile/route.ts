import { getStudentEntry } from "@/lib/experiment-entry";
import { NextResponse } from "next/server";
import { z } from "zod";
import { assertSameOrigin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { getParticipantProfile, updateParticipantIdentity } from "@/lib/participant-profile";
import { getAuthenticatedSession } from "@/lib/session";
import { sessionTransaction } from "@/lib/session-write";

export const runtime = "nodejs";

const inputSchema = z.object({
  fullName: z.string().trim().min(1, "请填写姓名，学号可以不填。").max(100),
  studentNumber: z.string().trim().max(100).default(""),
  revision: z.number().int().nonnegative().optional(),
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
    const profile = await sessionTransaction(session, (client) => updateParticipantIdentity(client,
      { ...input.data,participantId:session.participantId,experimentId:session.experimentId },null));
    const response = noStoreJson({ profile });
    return response;
  } catch (error) { return errorResponse(error); }
}
