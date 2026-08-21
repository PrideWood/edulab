CREATE TABLE IF NOT EXISTS participant_code_counters (
  experiment_id text PRIMARY KEY,
  last_value bigint NOT NULL CHECK (last_value > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
