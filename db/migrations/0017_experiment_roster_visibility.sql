-- Existing experiments keep their original management UI. Only experiments
-- created after this migration opt into roster allocation by default.
ALTER TABLE experiments ADD COLUMN IF NOT EXISTS roster_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE experiments ALTER COLUMN roster_enabled SET DEFAULT true;
