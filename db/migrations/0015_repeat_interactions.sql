-- Additive: retain identities, assignment rules, snapshots and original messages.
ALTER TABLE experiment_settings
  ADD COLUMN IF NOT EXISTS history_memory_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS history_memory_max_input_tokens integer NOT NULL DEFAULT 6000
    CHECK (history_memory_max_input_tokens BETWEEN 512 AND 100000);

CREATE UNIQUE INDEX IF NOT EXISTS participants_registration_request_idx
  ON participants (experiment_id,(metadata->>'registration_request_id'))
  WHERE metadata ? 'registration_request_id';

CREATE UNIQUE INDEX IF NOT EXISTS sessions_start_interaction_request_idx
  ON experiment_sessions (participant_id,COALESCE(experiment_run_id::text,''),(metadata->>'start_request_id'))
  WHERE metadata ? 'start_request_id';
