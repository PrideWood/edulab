ALTER TABLE experiment_runs DROP CONSTRAINT IF EXISTS experiment_runs_assignment_mode_check;
ALTER TABLE experiment_runs ADD CONSTRAINT experiment_runs_assignment_mode_check
  CHECK (assignment_mode IN ('fixed','balanced_random','roster'));
ALTER TABLE experiment_runs DROP CONSTRAINT IF EXISTS experiment_run_assignment_valid;
ALTER TABLE experiment_runs ADD CONSTRAINT experiment_run_assignment_valid CHECK (
  (assignment_mode='fixed' AND fixed_agent_id IS NOT NULL) OR
  (assignment_mode IN ('balanced_random','roster') AND cardinality(random_agent_ids)>=2)
);
ALTER TABLE participant_agent_assignments DROP CONSTRAINT IF EXISTS participant_agent_assignments_assignment_mode_check;
ALTER TABLE participant_agent_assignments ADD CONSTRAINT participant_agent_assignments_assignment_mode_check
  CHECK (assignment_mode IN ('fixed','balanced_random','roster'));

-- One unified roster entrance per experiment; retired links retain their data.
CREATE UNIQUE INDEX IF NOT EXISTS experiment_runs_one_roster_idx
  ON experiment_runs (experiment_id) WHERE assignment_mode='roster' AND entry_deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS roster_entries (
  id uuid PRIMARY KEY,
  experiment_run_id uuid NOT NULL REFERENCES experiment_runs(id) ON DELETE CASCADE,
  class_name text NOT NULL,
  identity_hash text NOT NULL,
  payload_ciphertext text NOT NULL,
  payload_iv text NOT NULL,
  payload_tag text NOT NULL,
  stratum text NOT NULL CHECK (stratum IN ('高','中','低')),
  agent_id uuid NOT NULL REFERENCES ai_agent_configs(id),
  participant_id uuid UNIQUE REFERENCES participants(id) ON DELETE SET NULL,
  UNIQUE (experiment_run_id,identity_hash)
);
CREATE INDEX IF NOT EXISTS roster_entries_run_idx ON roster_entries (experiment_run_id,agent_id);
