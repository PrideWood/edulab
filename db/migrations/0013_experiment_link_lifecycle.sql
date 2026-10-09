ALTER TABLE experiment_runs ADD COLUMN IF NOT EXISTS entry_deleted_at timestamptz;
ALTER TABLE experiment_runs ALTER COLUMN entry_token DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='experiment_runs'::regclass
    AND conname='experiment_runs_entry_lifecycle_check') THEN
    ALTER TABLE experiment_runs ADD CONSTRAINT experiment_runs_entry_lifecycle_check CHECK (
      (entry_deleted_at IS NULL AND entry_token IS NOT NULL)
      OR (entry_deleted_at IS NOT NULL AND entry_token IS NULL AND status='closed' AND is_default=false)
    );
  END IF;
END $$;
