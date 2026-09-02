CREATE TABLE IF NOT EXISTS ai_agent_configs (
  id uuid PRIMARY KEY,
  experiment_id text NOT NULL,
  internal_name text NOT NULL,
  coze_api_base_url text NOT NULL DEFAULT 'https://api.coze.com',
  coze_bot_id text NOT NULL,
  coze_token_ciphertext text,
  coze_token_iv text,
  coze_token_tag text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users(id),
  UNIQUE (experiment_id, internal_name),
  UNIQUE (experiment_id, coze_bot_id),
  CONSTRAINT ai_agent_token_complete CHECK (
    (coze_token_ciphertext IS NULL AND coze_token_iv IS NULL AND coze_token_tag IS NULL)
    OR
    (coze_token_ciphertext IS NOT NULL AND coze_token_iv IS NOT NULL AND coze_token_tag IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS ai_agent_configs_experiment_idx
  ON ai_agent_configs (experiment_id, enabled, updated_at DESC);

CREATE TABLE IF NOT EXISTS experiment_runs (
  id uuid PRIMARY KEY,
  experiment_id text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  assignment_mode text NOT NULL DEFAULT 'fixed' CHECK (assignment_mode IN ('fixed', 'balanced_random')),
  fixed_agent_id uuid REFERENCES ai_agent_configs(id),
  random_agent_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  config_version integer NOT NULL DEFAULT 1 CHECK (config_version > 0),
  opened_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users(id),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT experiment_run_assignment_valid CHECK (
    (assignment_mode = 'fixed' AND fixed_agent_id IS NOT NULL)
    OR
    (assignment_mode = 'balanced_random' AND cardinality(random_agent_ids) >= 2)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS experiment_runs_one_active_idx
  ON experiment_runs (experiment_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS experiment_runs_history_idx
  ON experiment_runs (experiment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS participant_agent_assignments (
  id uuid PRIMARY KEY,
  experiment_run_id uuid NOT NULL REFERENCES experiment_runs(id),
  participant_id uuid NOT NULL REFERENCES participants(id),
  agent_id uuid NOT NULL REFERENCES ai_agent_configs(id),
  assignment_mode text NOT NULL CHECK (assignment_mode IN ('fixed', 'balanced_random')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (experiment_run_id, participant_id)
);

CREATE INDEX IF NOT EXISTS participant_agent_assignments_run_agent_idx
  ON participant_agent_assignments (experiment_run_id, agent_id, assigned_at);

ALTER TABLE experiment_sessions
  ADD COLUMN IF NOT EXISTS experiment_run_id uuid REFERENCES experiment_runs(id),
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES ai_agent_configs(id);

CREATE INDEX IF NOT EXISTS experiment_sessions_run_idx
  ON experiment_sessions (experiment_run_id, started_at);

WITH legacy AS (
  SELECT
    (substr(md5(experiment_id || ':legacy-agent'), 1, 8) || '-' ||
     substr(md5(experiment_id || ':legacy-agent'), 9, 4) || '-' ||
     substr(md5(experiment_id || ':legacy-agent'), 13, 4) || '-' ||
     substr(md5(experiment_id || ':legacy-agent'), 17, 4) || '-' ||
     substr(md5(experiment_id || ':legacy-agent'), 21, 12))::uuid AS id,
    *
  FROM experiment_settings
  WHERE NULLIF(coze_bot_id, '') IS NOT NULL
)
INSERT INTO ai_agent_configs (
  id, experiment_id, internal_name, coze_api_base_url, coze_bot_id,
  coze_token_ciphertext, coze_token_iv, coze_token_tag, enabled, updated_by
)
SELECT id, experiment_id, '原有智能体', coze_api_base_url, coze_bot_id,
  coze_token_ciphertext, coze_token_iv, coze_token_tag, true, updated_by
FROM legacy
ON CONFLICT (experiment_id, coze_bot_id) DO NOTHING;

WITH legacy_agents AS (
  SELECT
    a.*,
    (substr(md5(a.experiment_id || ':legacy-run'), 1, 8) || '-' ||
     substr(md5(a.experiment_id || ':legacy-run'), 9, 4) || '-' ||
     substr(md5(a.experiment_id || ':legacy-run'), 13, 4) || '-' ||
     substr(md5(a.experiment_id || ':legacy-run'), 17, 4) || '-' ||
     substr(md5(a.experiment_id || ':legacy-run'), 21, 12))::uuid AS run_id
  FROM ai_agent_configs a
  WHERE a.internal_name = '原有智能体'
)
INSERT INTO experiment_runs (
  id, experiment_id, name, status, assignment_mode, fixed_agent_id,
  opened_at, updated_by, metadata
)
SELECT run_id, experiment_id, '默认场次', 'active', 'fixed', id,
  now(), updated_by, '{"migrated_from_single_agent":true}'::jsonb
FROM legacy_agents
ON CONFLICT DO NOTHING;

UPDATE experiment_sessions s
SET experiment_run_id = r.id, agent_id = r.fixed_agent_id
FROM experiment_runs r
WHERE s.experiment_id = r.experiment_id
  AND r.metadata->>'migrated_from_single_agent' = 'true'
  AND s.experiment_run_id IS NULL;
