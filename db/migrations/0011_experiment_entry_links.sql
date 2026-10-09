CREATE TABLE IF NOT EXISTS experiments (
  id text PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES admin_users(id)
);

INSERT INTO experiments (id, name)
SELECT existing.id, COALESCE(settings.task_title, existing.id) FROM (
  SELECT experiment_id AS id FROM experiment_settings
  UNION SELECT experiment_id FROM participants
  UNION SELECT experiment_id FROM experiment_runs
  UNION SELECT experiment_id FROM ai_agent_configs
) existing LEFT JOIN experiment_settings settings ON settings.experiment_id=existing.id ON CONFLICT DO NOTHING;

ALTER TABLE experiment_runs
  ADD COLUMN IF NOT EXISTS entry_token text,
  ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS config_snapshot jsonb;

-- Backfill classroom-friendly codes without changing any existing link.
DO $$
DECLARE
  run_record record;
  compact text;
  candidate text;
BEGIN
  FOR run_record IN SELECT id FROM experiment_runs WHERE entry_token IS NULL LOOP
    LOOP
      compact := translate(left(replace(gen_random_uuid()::text, '-', ''), 8), '01', 'xy');
      candidate := left(compact, 4) || '-' || right(compact, 4);
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM experiment_runs existing WHERE length(existing.entry_token)=9
          AND (SELECT count(*) FROM generate_series(1,8) position
            WHERE substr(replace(existing.entry_token, '-', ''), position, 1)=substr(compact, position, 1)) > 4
      );
    END LOOP;
    UPDATE experiment_runs SET entry_token=candidate WHERE id=run_record.id;
  END LOOP;
END $$;
UPDATE experiment_runs SET is_default=true WHERE status='active';
ALTER TABLE experiment_runs ALTER COLUMN entry_token SET NOT NULL;
ALTER TABLE experiment_runs ALTER COLUMN entry_token SET DEFAULT replace(gen_random_uuid()::text, '-', '');
CREATE UNIQUE INDEX IF NOT EXISTS experiment_runs_entry_token_idx ON experiment_runs(entry_token);
DROP INDEX IF EXISTS experiment_runs_one_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS experiment_runs_one_default_idx ON experiment_runs(experiment_id)
  WHERE status='active' AND is_default=true;
