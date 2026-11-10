-- Windows clients can call only this fixed read function and append-only ingestion.
CREATE OR REPLACE FUNCTION edulab_local_backup.sql_student_sync(p_device uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public, edulab_local_backup AS $$
SELECT jsonb_build_object(
 'revision',c.revision,'config',c.config,'updated_at',c.updated_at,
 'server_now',extract(epoch from clock_timestamp()),
 'assignments',coalesce((SELECT jsonb_agg(to_jsonb(a)) FROM public.sql_study_assignments a WHERE EXISTS(
  SELECT 1 FROM edulab_local_backup.latest_participants p WHERE p.device_id=p_device AND p.class_code=a.class_code
  AND p.participant_name=a.participant_name AND p.archive->>'study_schema'='sql-teachable-mvp/1')),'[]'::jsonb),
 'grades',coalesce((SELECT jsonb_agg(jsonb_build_object('participant_id',g.participant_id,'lesson',g.lesson,'scores',g.scores,'updated_at',g.updated_at))
  FROM public.sql_study_grades g WHERE g.device_id=p_device),'[]'::jsonb),
 'test_lesson_commands',coalesce((SELECT jsonb_agg(jsonb_build_object('id',x.id,'device_id',x.payload->>'deviceId','participant_id',x.payload->>'participantId',
   'lesson',x.payload->'lesson','test_identity_verified',true)) FROM (SELECT DISTINCT ON (a.payload->>'participantId') a.id,a.payload
   FROM public.sql_study_audit a WHERE a.action='test.lesson.select' AND a.payload->>'deviceId'=p_device::text
   AND EXISTS(SELECT 1 FROM edulab_local_backup.latest_participants p WHERE p.device_id=p_device AND p.participant_id::text=a.payload->>'participantId' AND p.is_test)
   ORDER BY a.payload->>'participantId',a.created_at DESC,a.id DESC) x),'[]'::jsonb))
FROM public.sql_study_control c WHERE c.id='sql-teachable-mvp/1';
$$;
REVOKE ALL ON FUNCTION edulab_local_backup.sql_student_sync(uuid) FROM PUBLIC;
