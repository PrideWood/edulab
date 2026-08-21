CREATE TABLE IF NOT EXISTS participants (
  id uuid PRIMARY KEY,
  experiment_id text NOT NULL,
  external_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (experiment_id, external_code)
);

CREATE TABLE IF NOT EXISTS experiment_sessions (
  id uuid PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE,
  participant_id uuid NOT NULL REFERENCES participants(id),
  experiment_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed')),
  session_secret_hash char(64) NOT NULL,
  coze_user_id text NOT NULL UNIQUE,
  coze_conversation_id text,
  active_request_id uuid,
  next_sequence integer NOT NULL DEFAULT 1 CHECK (next_sequence > 0),
  started_at timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS sessions_participant_idx ON experiment_sessions (participant_id, started_at DESC);

CREATE TABLE IF NOT EXISTS chat_requests (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES experiment_sessions(id),
  client_request_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress', 'completed', 'failed', 'uncertain')),
  user_message_id uuid NOT NULL,
  coze_chat_id text,
  coze_conversation_id text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  reply_started_at timestamptz,
  error_code text,
  error_message text,
  attempt_count integer NOT NULL DEFAULT 1,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (session_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS requests_session_status_idx ON chat_requests (session_id, status, requested_at);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY,
  session_id uuid NOT NULL REFERENCES experiment_sessions(id),
  chat_request_id uuid NOT NULL REFERENCES chat_requests(id),
  sequence_no integer NOT NULL,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'completed' CHECK (status = 'completed'),
  client_request_id uuid,
  coze_message_id text,
  coze_chat_id text,
  sent_at timestamptz NOT NULL,
  reply_started_at timestamptz,
  reply_completed_at timestamptz,
  latency_ms integer,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (session_id, sequence_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS messages_session_client_request_idx ON messages (session_id, client_request_id) WHERE client_request_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS messages_coze_message_idx ON messages (session_id, coze_message_id) WHERE coze_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_session_order_idx ON messages (session_id, sequence_no);
