-- Reserved numbered test names are excluded from formal assignment and summaries.
CREATE OR REPLACE FUNCTION edulab_local_backup.sql_is_test(p_name text,p_flag boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE SET search_path=pg_catalog AS $$
 SELECT coalesce(p_flag,false) OR lower(btrim(normalize(coalesce(p_name,''),NFKC))) ~ '^(柴博泉|测试|test|ceshi)([[:space:]_-]*[0-9]+)?$';
$$;
REVOKE ALL ON FUNCTION edulab_local_backup.sql_is_test(text,boolean) FROM PUBLIC;
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
 'pretest_score',coalesce(p.archive->'study'->'pretest'->'score','0'::jsonb),'pair_no',NULL,'batch_id',p.test_batch,'method','single_test_auto') FROM auto_tests p
 ) x),'[]'::jsonb),
 'grades',coalesce((SELECT jsonb_agg(jsonb_build_object('participant_id',g.participant_id,'lesson',g.lesson,'scores',g.scores,'updated_at',g.updated_at))
  FROM public.sql_study_grades g WHERE g.device_id=p_device),'[]'::jsonb),
 'test_lesson_commands',coalesce((SELECT jsonb_agg(x.item) FROM (
 SELECT jsonb_build_object('id',e.id,'device_id',p_device,'participant_id',e.payload->>'participantId',
 'lesson',e.payload->'lesson','scheme_version','business-workorders/1','research_version','sql-lt/1.1','test_identity_verified',true) AS item FROM explicit_commands e
 UNION ALL
 SELECT jsonb_build_object('id',coalesce(p.archive->'study'->'test_lesson_control'->>'id',md5('sql-auto-entry/1:'||p_device::text||':'||p.participant_id::text)),
 'automatic_entry',true,'device_id',p_device,'participant_id',p.participant_id,'lesson',p.test_lesson,'scheme_version','business-workorders/1','research_version','sql-lt/1.1','test_identity_verified',true)
 FROM auto_tests p WHERE NOT EXISTS(SELECT 1 FROM explicit_commands e WHERE e.payload->>'participantId'=p.participant_id::text)
 ) x),'[]'::jsonb))
FROM public.sql_study_control c WHERE c.id='sql-teachable-mvp/1';
$$;
REVOKE ALL ON FUNCTION edulab_local_backup.sql_student_sync(uuid) FROM PUBLIC;

INSERT INTO sql_study_audit(id,action,payload) VALUES(gen_random_uuid(),'test.numbered_identities',jsonb_build_object('classification','reserved-name-number/1','optional_baseline_for_tests',true));
