CREATE TABLE IF NOT EXISTS admin_users (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until timestamptz
);

ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS failed_login_count integer NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS locked_until timestamptz;

CREATE TABLE IF NOT EXISTS experiment_settings (
  experiment_id text PRIMARY KEY,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  task_visible boolean NOT NULL DEFAULT true,
  chat_enabled boolean NOT NULL DEFAULT true,
  task_label text NOT NULL,
  task_title text NOT NULL,
  task_introduction text NOT NULL,
  task_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  task_material text NOT NULL DEFAULT '',
  task_hint text NOT NULL DEFAULT '',
  assistant_name text NOT NULL DEFAULT '学习助理',
  welcome_message text NOT NULL DEFAULT '',
  max_user_messages integer CHECK (max_user_messages IS NULL OR max_user_messages > 0),
  max_message_chars integer NOT NULL DEFAULT 2000 CHECK (max_message_chars BETWEEN 1 AND 20000),
  session_duration_minutes integer CHECK (session_duration_minutes IS NULL OR session_duration_minutes > 0),
  coze_api_base_url text NOT NULL DEFAULT 'https://api.coze.com',
  coze_bot_id text,
  coze_token_ciphertext text,
  coze_token_iv text,
  coze_token_tag text,
  extra jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES admin_users(id)
);

CREATE TABLE IF NOT EXISTS admin_audit_log (
  id uuid PRIMARY KEY,
  admin_user_id uuid REFERENCES admin_users(id),
  action text NOT NULL,
  experiment_id text,
  before_data jsonb,
  after_data jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS admin_audit_experiment_idx ON admin_audit_log (experiment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_user_idx ON admin_audit_log (admin_user_id, created_at DESC);

ALTER TABLE experiment_sessions ADD COLUMN IF NOT EXISTS config_version integer;
ALTER TABLE experiment_sessions ADD COLUMN IF NOT EXISTS config_snapshot jsonb;
