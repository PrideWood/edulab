import { NextResponse } from "next/server";
import { getStudentEntry } from "@/lib/experiment-entry";
import { ApiError, errorResponse } from "@/lib/http";
import { buildParticipantTranscriptArchive } from "@/lib/participant-export";
import { getAuthenticatedSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const entry = await getStudentEntry(request);
    if (!entry) throw new ApiError(400,"ENTRY_REQUIRED","请使用教师提供的实验链接进入。");
    const session = await getAuthenticatedSession(entry);
    if (!session) throw new ApiError(401,"SESSION_REQUIRED","会话已失效，请重新登录后下载记录。");
    return NextResponse.json(await buildParticipantTranscriptArchive(session),{headers:{"Cache-Control":"private, no-store"}});
  } catch (error) { return errorResponse(error); }
}
