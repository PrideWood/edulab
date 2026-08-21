import { NextResponse } from "next/server";
import { experiment } from "@/config/experiment";
import { query } from "@/db";
import { getAuthenticatedAdmin } from "@/lib/admin-auth";
import { ApiError, errorResponse } from "@/lib/http";
import { profileFromRow } from "@/lib/participant-profile";

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
