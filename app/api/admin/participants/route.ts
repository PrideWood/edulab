import { NextResponse } from "next/server";
import { z } from "zod";
import { experiment } from "@/config/experiment";
import { query } from "@/db";
import { deleteParticipantRecord } from "@/lib/admin-records";
import { assertSameOrigin, getAuthenticatedAdmin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { profileFromRow } from "@/lib/participant-profile";
import { SESSION_COOKIE } from "@/lib/security";
import { clearRuntimeCookie, getRuntimeSession } from "@/lib/runtime-session";

export const runtime = "nodejs";

interface ParticipantRow {
  id: string;
  external_code: string;
  created_at: string;
  full_name_ciphertext: string | null;
  full_name_iv: string | null;
  full_name_tag: string | null;
  student_number_ciphertext: string | null;
  student_number_iv: string | null;
  student_number_tag: string | null;
  updated_at: string | null;
  session_count: string;
  turn_count: string;
  last_activity_at: string | null;
}

const deleteSchema = z.object({
  participantId: z.uuid(),
  confirmationCode: z.string().trim().min(1).max(100),
});

function participantDeleteError(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  if (message === "PARTICIPANT_NOT_FOUND") return new ApiError(404, message, "找不到这条参与者记录，可能已被删除。");
  if (message === "PARTICIPANT_CONFIRMATION_MISMATCH") return new ApiError(400, message, "输入的 Participant ID 不一致，未执行删除。");
  return error;
}

export async function GET() {
  try {
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const result = await query<ParticipantRow>(
      `SELECT p.id, p.external_code, p.created_at,
         profile.full_name_ciphertext, profile.full_name_iv, profile.full_name_tag,
         profile.student_number_ciphertext, profile.student_number_iv, profile.student_number_tag,
         profile.updated_at,
         count(DISTINCT session.id)::text AS session_count,
         count(DISTINCT request.id)::text AS turn_count,
         max(session.last_activity_at)::text AS last_activity_at
       FROM participants p
       LEFT JOIN participant_identity_profiles profile ON profile.participant_id = p.id
       LEFT JOIN experiment_sessions session ON session.participant_id = p.id AND session.experiment_id = p.experiment_id
       LEFT JOIN chat_requests request ON request.session_id = session.id
       WHERE p.experiment_id = $1
       GROUP BY p.id, profile.participant_id
       ORDER BY max(session.last_activity_at) DESC NULLS LAST, p.created_at DESC
       LIMIT 500`,
      [experiment.id],
    );
    const participants = result.rows.map((row) => {
      const profile = row.updated_at ? profileFromRow({ ...row, updated_at: row.updated_at }) : null;
      return {
        id: row.id,
        participantCode: row.external_code,
        fullName: profile?.fullName ?? "",
        studentNumber: profile?.studentNumber ?? "",
        profileUpdatedAt: profile?.updatedAt ?? null,
        sessionCount: Number(row.session_count),
        turnCount: Number(row.turn_count),
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
      };
    });
    return NextResponse.json({ participants }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    const admin = await getAuthenticatedAdmin();
    if (!admin) throw new ApiError(401, "ADMIN_REQUIRED", "请先登录管理后台。");
    const input = deleteSchema.safeParse(await request.json());
    if (!input.success) throw new ApiError(400, "INVALID_PARTICIPANT_DELETE", "删除确认信息无效。");
    const deleted = await deleteParticipantRecord({ ...input.data, experimentId: experiment.id }, admin.id);
    const response = NextResponse.json({ deleted });
    const runtime = await getRuntimeSession();
    if (runtime?.session.participantId === deleted.participantId) {
      response.cookies.set(SESSION_COOKIE, "", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        path: "/",
        maxAge: 0,
      });
      clearRuntimeCookie(response);
    }
    return response;
  } catch (error) { return errorResponse(participantDeleteError(error)); }
}
