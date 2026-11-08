-- Classification only: participant, conversation and raw backup rows stay intact.
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS archived_at timestamptz;
UPDATE experiments SET archived_at=now() WHERE name LIKE '%科学教育%' AND archived_at IS NULL;
CREATE TABLE IF NOT EXISTS sql_study_control (
  id text PRIMARY KEY CHECK (id='sql-teachable-mvp/1'),
  revision integer NOT NULL DEFAULT 1,
  config jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users(id)
);
CREATE TABLE IF NOT EXISTS sql_study_assignments (
  class_code text NOT NULL,
  participant_name text NOT NULL,
  group_code text NOT NULL CHECK (group_code IN ('L','T')),
  pretest_score numeric NOT NULL,
  pair_no integer,
  batch_id uuid NOT NULL,
  method text NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_code,participant_name)
);
CREATE TABLE IF NOT EXISTS sql_study_grades (
  device_id uuid NOT NULL,participant_id uuid NOT NULL,lesson integer NOT NULL CHECK (lesson BETWEEN 0 AND 2),
  scores jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),updated_by uuid REFERENCES admin_users(id),
  PRIMARY KEY(device_id,participant_id,lesson)
);
CREATE TABLE IF NOT EXISTS sql_study_audit (
  id uuid PRIMARY KEY,created_at timestamptz NOT NULL DEFAULT now(),admin_id uuid REFERENCES admin_users(id),
  action text NOT NULL,payload jsonb NOT NULL
);
