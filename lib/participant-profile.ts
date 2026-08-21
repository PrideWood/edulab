import "server-only";

import { query } from "@/db";
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
  };
}

export async function getParticipantProfile(participantId: string): Promise<ParticipantProfile | null> {
  const result = await query<ProfileRow>(
    `SELECT full_name_ciphertext, full_name_iv, full_name_tag,
       student_number_ciphertext, student_number_iv, student_number_tag, updated_at
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

export async function saveParticipantProfile(participantId: string, fullName: string, studentNumber: string) {
  const name = encryptedValues(fullName);
  const number = encryptedValues(studentNumber);
  const result = await query<ProfileRow>(
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
       student_number_ciphertext, student_number_iv, student_number_tag, updated_at`,
    [participantId, ...name, ...number],
  );
  return profileFromRow(result.rows[0]);
}
