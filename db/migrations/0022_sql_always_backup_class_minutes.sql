-- Upgrade study defaults only; never rewrite existing student round snapshots.
DO $$
DECLARE old_config jsonb; next_config jsonb; cls text; k text;
BEGIN
 SELECT config INTO old_config FROM sql_study_control WHERE id='sql-teachable-mvp/1' FOR UPDATE;
 IF old_config IS NULL THEN RETURN; END IF;
 next_config=jsonb_set(old_config,'{backup_enabled}','true');
 next_config=jsonb_set(next_config,'{demonstration_minutes}',coalesce(old_config->'demonstration_minutes','40'::jsonb));
 IF old_config->>'teaching_seconds'='30' AND old_config->>'practice_seconds'='120' AND old_config->>'quiz_seconds'='120' THEN
   next_config=jsonb_set(jsonb_set(jsonb_set(next_config,'{teaching_seconds}','900'),'{practice_seconds}','900'),'{quiz_seconds}','600');
 END IF;
 FOR cls IN SELECT jsonb_object_keys(next_config->'schedules') LOOP
   FOR k IN SELECT jsonb_object_keys(next_config->'schedules'->cls) LOOP
     IF k ~ '^practice[0-2]$' AND next_config->'schedules'->cls->k->>'mode' IN ('open','closed') THEN
       next_config=jsonb_set(next_config,ARRAY['schedules',cls,k],'{"mode":"auto","open_at":null,"close_at":null}'::jsonb);
     END IF;
   END LOOP;
 END LOOP;
 IF next_config IS DISTINCT FROM old_config THEN
   UPDATE sql_study_control SET config=next_config,revision=revision+1,updated_at=now() WHERE id='sql-teachable-mvp/1';
   INSERT INTO sql_study_audit(id,action,payload) VALUES(gen_random_uuid(),'control.always_backup_and_minutes',jsonb_build_object('before',old_config,'after',next_config));
 END IF;
END $$;
