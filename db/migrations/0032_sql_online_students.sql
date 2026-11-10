-- Browser sessions are scoped to an HttpOnly device cookie and a separate participant capability.
CREATE TABLE IF NOT EXISTS sql_online_students (
 device_id uuid NOT NULL, participant_id uuid NOT NULL, class_code text NOT NULL, participant_name text NOT NULL,
 session_hash text NOT NULL, state jsonb NOT NULL, revision bigint NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(device_id,participant_id),UNIQUE(device_id,class_code,participant_name)
);
REVOKE ALL ON sql_online_students FROM PUBLIC;
CREATE INDEX IF NOT EXISTS sql_online_student_identity ON sql_online_students(class_code,participant_name);
