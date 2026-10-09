-- Additive migration: preserve all participants, assignments and transcripts.
ALTER TABLE experiment_sessions
  ADD COLUMN IF NOT EXISTS draft_text text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft_revision integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS participant_recovery_attempts (
  bucket_hash char(64) PRIMARY KEY,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 1
);
