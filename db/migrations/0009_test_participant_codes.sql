ALTER TABLE participant_code_counters
  DROP CONSTRAINT IF EXISTS participant_code_counters_last_value_check;

ALTER TABLE participant_code_counters
  ADD CONSTRAINT participant_code_counters_last_value_check CHECK (last_value >= 0),
  ADD COLUMN IF NOT EXISTS test_last_value bigint NOT NULL DEFAULT 0 CHECK (test_last_value >= 0);

INSERT INTO participant_code_counters (experiment_id, last_value, test_last_value)
SELECT participant.experiment_id,
  COALESCE(max(substring(participant.external_code FROM 2)::bigint)
    FILTER (WHERE participant.external_code ~ '^P[0-9]+$'), 0),
  COALESCE(max(substring(participant.external_code FROM 2)::bigint)
    FILTER (WHERE participant.external_code ~ '^T[0-9]+$'), 0)
FROM participants participant
WHERE participant.external_code ~ '^[PT][0-9]+$'
GROUP BY participant.experiment_id
ON CONFLICT (experiment_id) DO UPDATE SET
  last_value = GREATEST(participant_code_counters.last_value, EXCLUDED.last_value),
  test_last_value = GREATEST(participant_code_counters.test_last_value, EXCLUDED.test_last_value),
  updated_at = now();
