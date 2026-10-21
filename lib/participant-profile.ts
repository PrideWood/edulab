import "server-only";

import type { PoolClient } from "pg";
import { createHmac, randomUUID } from "node:crypto";
import { query, transaction } from "@/db";
import { ApiError } from "@/lib/http";
import type { ParticipantProfile } from "@/lib/client-types";
import { decryptSecret, encryptSecret, type EncryptedSecret } from "@/lib/secret-crypto";

interface ProfileRow {
  full_name_ciphertext: string | null;
  full_name_iv: string | null;
  full_name_tag: string | null;
  student_number_ciphertext: string | null;
  student_number_iv: string | null;
  student_number_tag: string | null;
  updated_at: string;
  revision?: number | null;
}

function decryptField(ciphertext: string | null, iv: string | null, tag: string | null) {
  if (!ciphertext || !iv || !tag) return "";
  return decryptSecret({ ciphertext, iv, tag });
}

export function profileFromRow(row: ProfileRow): ParticipantProfile {
  return {
    fullName: decryptField(row.full_name_ciphertext, row.full_name_iv, row.full_name_tag),
    studentNumber: decryptField(row.student_number_ciphertext, row.student_number_iv, row.student_number_tag),
    updatedAt: row.updated_at,
    revision: row.revision ?? 1,
  };
}

export async function getParticipantProfile(participantId: string): Promise<ParticipantProfile | null> {
  const result = await query<ProfileRow>(
    `SELECT full_name_ciphertext, full_name_iv, full_name_tag,
       student_number_ciphertext, student_number_iv, student_number_tag, updated_at, revision
     FROM participant_identity_profiles
     WHERE participant_id = $1`,
    [participantId],
  );
  return result.rows[0] ? profileFromRow(result.rows[0]) : null;
}

function encryptedValues(value: string): [string | null, string | null, string | null] {
  if (!value) return [null, null, null];
  const encrypted: EncryptedSecret = encryptSecret(value);
  return [encrypted.ciphertext, encrypted.iv, encrypted.tag];
}

export async function saveParticipantProfileWithClient(client: PoolClient, participantId: string, fullName: string, studentNumber: string) {
  fullName = fullName.trim();
  studentNumber = studentNumber.trim();
  // Names are never identity keys. Only competing claims for the same number
  // must serialize; unrelated students must not hold up the entire classroom.
  const participant = await client.query<{ experiment_id: string }>("SELECT experiment_id FROM participants WHERE id=$1", [participantId]);
  if (!participant.rows[0]) throw new ApiError(404, "PARTICIPANT_NOT_FOUND", "找不到这条参与者记录。");
  const experimentId = participant.rows[0].experiment_id;
  if (studentNumber) {
    const key = process.env.SETTINGS_ENCRYPTION_KEY;
    if (!key || key.length < 32) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured");
    const identityKey = createHmac("sha256", key).update(JSON.stringify([experimentId, studentNumber])).digest("hex");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`edulab:identity-number:${identityKey}`]);
    const others = await client.query<ProfileRow>(`SELECT profile.* FROM participant_identity_profiles profile
      JOIN participants p ON p.id=profile.participant_id
      WHERE p.experiment_id=$1 AND p.id<>$2 AND profile.student_number_ciphertext IS NOT NULL`, [experimentId, participantId]);
    if (others.rows.some(row => decryptField(row.student_number_ciphertext, row.student_number_iv, row.student_number_tag).trim() === studentNumber)) {
      throw new ApiError(409, "STUDENT_NUMBER_EXISTS", "当前项目已有此学号。请使用原编号和原分组链接继续实验，或联系教师纠正信息。");
    }
  }
  const name = encryptedValues(fullName);
  const number = encryptedValues(studentNumber);
  const result = await client.query<ProfileRow>(
    `INSERT INTO participant_identity_profiles (
       participant_id, full_name_ciphertext, full_name_iv, full_name_tag,
       student_number_ciphertext, student_number_iv, student_number_tag
     ) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (participant_id) DO UPDATE SET
       full_name_ciphertext = EXCLUDED.full_name_ciphertext,
       full_name_iv = EXCLUDED.full_name_iv,
       full_name_tag = EXCLUDED.full_name_tag,
       student_number_ciphertext = EXCLUDED.student_number_ciphertext,
       student_number_iv = EXCLUDED.student_number_iv,
       student_number_tag = EXCLUDED.student_number_tag,
       revision = participant_identity_profiles.revision + 1,
       updated_at = now()
     RETURNING full_name_ciphertext, full_name_iv, full_name_tag,
       student_number_ciphertext, student_number_iv, student_number_tag, updated_at, revision`,
    [participantId, ...name, ...number],
  );
  return profileFromRow(result.rows[0]);
}

export async function saveParticipantProfile(participantId: string, fullName: string, studentNumber: string) {
  return transaction((client) => saveParticipantProfileWithClient(client, participantId, fullName, studentNumber));
}

export async function updateParticipantIdentity(client: PoolClient, input: {
  participantId: string; experimentId: string; fullName: string; studentNumber: string; revision?: number;
}, adminUserId: string | null) {
  const participant = await client.query<{ external_code: string }>(
    "SELECT external_code FROM participants WHERE id=$1 AND experiment_id=$2 FOR UPDATE", [input.participantId,input.experimentId]);
  if (!participant.rows[0]) throw new ApiError(404, "PARTICIPANT_NOT_FOUND", "找不到这条参与者记录。");
  const rows = await client.query<ProfileRow>("SELECT * FROM participant_identity_profiles WHERE participant_id=$1 FOR UPDATE", [input.participantId]);
  const before = rows.rows[0] ? profileFromRow(rows.rows[0]) : null;
  if (input.revision !== undefined && input.revision !== (before?.revision ?? 0)) {
    throw new ApiError(409, "PROFILE_CHANGED", "身份信息已被其他窗口修改，请刷新后核对再保存。");
  }
  if (before?.fullName === input.fullName.trim() && before.studentNumber === input.studentNumber.trim()) return before;
  const after = await saveParticipantProfileWithClient(client,input.participantId,input.fullName,input.studentNumber);
  const summary = { participantId:input.participantId, participantCode:participant.rows[0].external_code };
  // Keep identity edits traceable without introducing plaintext PII into logs.
  await client.query(`INSERT INTO admin_audit_log (id,admin_user_id,action,experiment_id,before_data,after_data)
    VALUES ($1,$2,'participant.identity.update',$3,$4::jsonb,$5::jsonb)`,
  [randomUUID(),adminUserId,input.experimentId,JSON.stringify({...summary,profile:encryptSecret(JSON.stringify(before))}),
    JSON.stringify({...summary,profile:encryptSecret(JSON.stringify(after))})]);
  return after;
}

export async function listParticipantIdentityChanges(experimentId: string, participantId: string) {
  const participant = await query("SELECT id FROM participants WHERE id=$1 AND experiment_id=$2", [participantId,experimentId]);
  if (!participant.rows[0]) throw new ApiError(404,"PARTICIPANT_NOT_FOUND","找不到这条参与者记录。");
  const result = await query<{ id: string; created_at: string; display_name: string | null;
    before_data: { profile: EncryptedSecret }; after_data: { profile: EncryptedSecret } }>(
    `SELECT log.id,log.created_at,admin.display_name,log.before_data,log.after_data FROM admin_audit_log log
     LEFT JOIN admin_users admin ON admin.id=log.admin_user_id
     WHERE log.experiment_id=$1 AND log.action='participant.identity.update' AND log.after_data->>'participantId'=$2
     ORDER BY log.created_at DESC,log.id DESC LIMIT 100`, [experimentId,participantId]);
  return result.rows.map(row => ({ id:row.id,changedAt:row.created_at,administrator:row.display_name ?? "学生本人",
    before:JSON.parse(decryptSecret(row.before_data.profile)) as ParticipantProfile | null,
    after:JSON.parse(decryptSecret(row.after_data.profile)) as ParticipantProfile }));
}
