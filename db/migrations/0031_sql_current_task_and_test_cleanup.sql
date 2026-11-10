-- 0.11.0: current task only; historical schedule values no longer control student access.
-- Deployment runner saves a private backup before applying this cleanup transaction.
CREATE TABLE IF NOT EXISTS sql_study_retired_test_identities (
 device_id uuid NOT NULL,participant_id uuid NOT NULL,epoch text NOT NULL,retired_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(device_id,participant_id)
);
REVOKE ALL ON sql_study_retired_test_identities FROM PUBLIC;
INSERT INTO sql_study_retired_test_identities(device_id,participant_id,epoch)
 SELECT device_id,participant_id,'sql-clean-20261110-01' FROM edulab_local_backup.latest_participants
 WHERE archive->>'study_schema'='sql-teachable-mvp/1' AND edulab_local_backup.sql_is_test(participant_name,is_test)
 ON CONFLICT DO NOTHING;
INSERT INTO local_backup_dispositions(device_id,participant_id,is_trashed)
 SELECT device_id,participant_id,true FROM sql_study_retired_test_identities
 ON CONFLICT(device_id,participant_id) DO UPDATE SET is_trashed=true,updated_at=now();
DELETE FROM sql_study_research_assessments a USING sql_study_retired_test_identities r WHERE a.device_id=r.device_id AND a.participant_id=r.participant_id;
DELETE FROM sql_study_grades a USING sql_study_retired_test_identities r WHERE a.device_id=r.device_id AND a.participant_id=r.participant_id;
DELETE FROM sql_study_assignments a WHERE EXISTS(SELECT 1 FROM edulab_local_backup.latest_participants p WHERE p.class_code=a.class_code AND p.participant_name=a.participant_name AND p.archive->>'study_schema'='sql-teachable-mvp/1' AND edulab_local_backup.sql_is_test(p.participant_name,p.is_test));
DELETE FROM sql_study_audit a USING sql_study_retired_test_identities r WHERE a.action='test.lesson.select' AND a.payload->>'deviceId'=r.device_id::text AND a.payload->>'participantId'=r.participant_id::text;
DELETE FROM edulab_local_backup.snapshots s USING sql_study_retired_test_identities r WHERE s.device_id=r.device_id AND s.participant_id=r.participant_id AND s.archive->>'study_schema'='sql-teachable-mvp/1';
DO $migration$
DECLARE old_row sql_study_control%ROWTYPE; next_config jsonb; cls text; lessons jsonb='{}'::jsonb; clean_schedules jsonb='{}'::jsonb; rules jsonb; k text; next_revision int;
BEGIN
 SELECT * INTO old_row FROM sql_study_control WHERE id='sql-teachable-mvp/1' FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 INSERT INTO sql_study_versions(revision,prompt_version,config,summary) VALUES(old_row.revision,(old_row.config->>'prompt_version')::int,old_row.config,'["升级前配置已封存"]'::jsonb) ON CONFLICT DO NOTHING;
 FOR cls IN SELECT c->>'code' FROM jsonb_array_elements(old_row.config->'classes') c LOOP lessons=jsonb_set(lessons,ARRAY[cls],'4'::jsonb);rules='{}'::jsonb;FOR k IN SELECT jsonb_object_keys(old_row.config->'schedules'->cls) LOOP rules=jsonb_set(rules,ARRAY[k],jsonb_build_object('mode',CASE WHEN k LIKE 'practice%' THEN 'auto' ELSE 'open' END,'open_at',NULL,'close_at',NULL));END LOOP;clean_schedules=jsonb_set(clean_schedules,ARRAY[cls],rules);END LOOP;
 next_config=old_row.config||jsonb_build_object('access_policy','current-task/1','current_lessons',lessons,'test_cleanup_epoch','sql-clean-20261110-01','minimum_student_version','0.11.0','schedules',clean_schedules);next_revision=old_row.revision+1;
 UPDATE sql_study_control SET config=next_config,revision=next_revision,updated_at=now() WHERE id=old_row.id;
 INSERT INTO sql_study_versions(revision,prompt_version,config,summary) VALUES(next_revision,(next_config->>'prompt_version')::int,next_config,'["当前任务模式：取消定时开放；每班每次只做当次任务；前台累计计时；旧测试数据已备份清理"]'::jsonb);
 INSERT INTO sql_study_audit(id,action,payload) VALUES(gen_random_uuid(),'current_task.upgrade',jsonb_build_object('revision',next_revision,'retired_test_identities',(SELECT count(*) FROM sql_study_retired_test_identities)));
END;
$migration$;
CREATE OR REPLACE FUNCTION edulab_local_backup.sql_student_sync(p_device uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, edulab_local_backup AS $$
WITH people AS MATERIALIZED (
 SELECT p.*,edulab_local_backup.sql_is_test(p.participant_name,p.is_test) AS test_identity
 FROM edulab_local_backup.latest_participants p
 WHERE p.device_id=p_device AND p.archive->>'study_schema'='sql-teachable-mvp/1'
 AND NOT EXISTS(SELECT 1 FROM public.local_backup_dispositions d WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed)
), explicit_commands AS (
 SELECT DISTINCT ON (a.payload->>'participantId') a.id::text AS id,a.payload
 FROM public.sql_study_audit a JOIN people p ON p.participant_id::text=a.payload->>'participantId' AND p.test_identity
 WHERE a.action='test.lesson.select' AND a.payload->>'scheme_version'='business-workorders/1' AND a.payload->>'research_version'='sql-lt/1.1'
 AND a.payload->>'deviceId'=p_device::text
 ORDER BY a.payload->>'participantId',a.created_at DESC,a.id DESC
), auto_tests AS (
 SELECT DISTINCT ON (p.class_code,p.participant_name) p.*,
 coalesce((SELECT r->>'group' FROM jsonb_array_elements(coalesce(p.archive->'study'->'rounds','[]'::jsonb)) WITH ORDINALITY AS x(r,n) WHERE r->>'group' IN ('L','T') ORDER BY n DESC LIMIT 1),
 a.group_code,CASE WHEN p.archive->'study'->>'group' IN ('L','T') THEN p.archive->'study'->>'group' END,'L') AS test_group,
 coalesce(a.batch_id,md5('sql-test-auto:'||p_device::text||':'||p.participant_id::text)::uuid) AS test_batch,
 CASE WHEN p.archive->'study'->'test_lesson_control'->>'lesson' IN ('0','1','2','3','4') THEN (p.archive->'study'->'test_lesson_control'->>'lesson')::int
 ELSE coalesce((SELECT (r->>'index')::int FROM jsonb_array_elements(coalesce(p.archive->'study'->'rounds','[]'::jsonb)) WITH ORDINALITY AS x(r,n) WHERE r->>'index' IN ('0','1','2','3','4') ORDER BY n DESC LIMIT 1),4) END AS test_lesson
 FROM people p LEFT JOIN public.sql_study_assignments a ON a.class_code=p.class_code AND a.participant_name=p.participant_name
 WHERE p.test_identity AND p.archive->'study'->>'research_version'='sql-lt/1.1'
 AND jsonb_typeof(p.archive->'study'->'pretest'->'score')='number'
 ORDER BY p.class_code,p.participant_name,p.received_at DESC,p.participant_id
)
SELECT jsonb_build_object(
 'retired_test_participant_ids',coalesce((SELECT jsonb_agg(r.participant_id) FROM public.sql_study_retired_test_identities r WHERE r.device_id=p_device),'[]'::jsonb),
 'research_assessments',coalesce((SELECT jsonb_agg(jsonb_build_object('participant_id',a.participant_id,'assessment',a.assessment,'protocol_version',a.protocol_version,'payload',a.payload,'revision',a.revision)) FROM public.sql_study_research_assessments a WHERE a.device_id=p_device AND a.protocol_version='sql-lt/1.1'),'[]'::jsonb),
 'revision',c.revision,'config',c.config,'updated_at',c.updated_at,
 'server_now',extract(epoch from clock_timestamp()),
 'assignments',coalesce((SELECT jsonb_agg(x.item) FROM (
 SELECT to_jsonb(a) AS item FROM public.sql_study_assignments a WHERE EXISTS(SELECT 1 FROM people p WHERE NOT p.test_identity AND p.class_code=a.class_code AND p.participant_name=a.participant_name)
 UNION ALL
 SELECT jsonb_build_object('class_code',p.class_code,'participant_name',p.participant_name,'group_code',p.test_group,
 'pretest_score',p.archive->'study'->'pretest'->'score','pair_no',NULL,'batch_id',p.test_batch,'method','single_test_auto') FROM auto_tests p
 ) x),'[]'::jsonb),
 'grades',coalesce((SELECT jsonb_agg(jsonb_build_object('participant_id',g.participant_id,'lesson',g.lesson,'scores',g.scores,'updated_at',g.updated_at))
  FROM public.sql_study_grades g WHERE g.device_id=p_device),'[]'::jsonb),
 'test_lesson_commands',coalesce((SELECT jsonb_agg(x.item) FROM (
 SELECT jsonb_build_object('id',e.id,'device_id',p_device,'participant_id',e.payload->>'participantId',
 'lesson',e.payload->'lesson','scheme_version','business-workorders/1','research_version','sql-lt/1.1','test_identity_verified',true) AS item FROM explicit_commands e
 UNION ALL
 SELECT jsonb_build_object('id',coalesce(p.archive->'study'->'test_lesson_control'->>'id',md5('sql-auto-entry/1:'||p_device::text||':'||p.participant_id::text)),
 'device_id',p_device,'participant_id',p.participant_id,'lesson',p.test_lesson,'scheme_version','business-workorders/1','research_version','sql-lt/1.1','test_identity_verified',true)
 FROM auto_tests p WHERE NOT EXISTS(SELECT 1 FROM explicit_commands e WHERE e.payload->>'participantId'=p.participant_id::text)
 ) x),'[]'::jsonb))
FROM public.sql_study_control c WHERE c.id='sql-teachable-mvp/1';
$$;
REVOKE ALL ON FUNCTION edulab_local_backup.sql_student_sync(uuid) FROM PUBLIC;
