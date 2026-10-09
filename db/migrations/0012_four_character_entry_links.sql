-- Shorten displayed links while preserving old URLs as aliases. No participant,
-- assignment, message or session record is recreated or deleted.
SELECT pg_advisory_xact_lock(hashtextextended('edulab:entry-links',0));
LOCK TABLE experiment_runs IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE
  run_record record;
  candidate text;
BEGIN
  FOR run_record IN SELECT id, entry_token FROM experiment_runs WHERE length(entry_token)<>4 LOOP
    LOOP
      candidate := translate(left(replace(gen_random_uuid()::text, '-', ''), 4), '01', 'xy');
      EXIT WHEN NOT EXISTS (
        SELECT 1 FROM experiment_runs existing WHERE length(existing.entry_token)=4
          AND (SELECT count(*) FROM generate_series(1,4) position
            WHERE substr(existing.entry_token, position, 1)=substr(candidate, position, 1)) > 2
      );
    END LOOP;
    UPDATE experiment_runs SET entry_token=candidate,
      metadata=jsonb_set(metadata, '{entry_token_aliases}',
        COALESCE(metadata->'entry_token_aliases', '[]'::jsonb) || jsonb_build_array(run_record.entry_token), true)
      WHERE id=run_record.id;
  END LOOP;
END $$;
ALTER TABLE experiment_runs ALTER COLUMN entry_token SET DEFAULT
  translate(left(replace(gen_random_uuid()::text, '-', ''), 4), '01', 'xy');
