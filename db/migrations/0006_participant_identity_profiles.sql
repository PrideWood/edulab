CREATE TABLE IF NOT EXISTS participant_identity_profiles (
  participant_id uuid PRIMARY KEY REFERENCES participants(id) ON DELETE CASCADE,
  full_name_ciphertext text,
  full_name_iv text,
  full_name_tag text,
  student_number_ciphertext text,
  student_number_iv text,
  student_number_tag text,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT participant_identity_has_value CHECK (
    full_name_ciphertext IS NOT NULL OR student_number_ciphertext IS NOT NULL
  ),
  CONSTRAINT participant_identity_full_name_complete CHECK (
    (full_name_ciphertext IS NULL AND full_name_iv IS NULL AND full_name_tag IS NULL)
    OR
    (full_name_ciphertext IS NOT NULL AND full_name_iv IS NOT NULL AND full_name_tag IS NOT NULL)
  ),
  CONSTRAINT participant_identity_student_number_complete CHECK (
    (student_number_ciphertext IS NULL AND student_number_iv IS NULL AND student_number_tag IS NULL)
    OR
    (student_number_ciphertext IS NOT NULL AND student_number_iv IS NOT NULL AND student_number_tag IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS participant_identity_updated_idx
  ON participant_identity_profiles (updated_at DESC);
