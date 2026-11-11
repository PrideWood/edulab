CREATE TABLE IF NOT EXISTS sql_practice_attachments(
 id uuid PRIMARY KEY,device_id uuid NOT NULL,participant_id uuid NOT NULL,round_id uuid NOT NULL,submission_id uuid NOT NULL,
 object_suffix text NOT NULL UNIQUE,sha256 text NOT NULL CHECK(sha256 ~ '^[a-f0-9]{64}$'),size_bytes int NOT NULL CHECK(size_bytes BETWEEN 1 AND 2097152),mime text NOT NULL CHECK(mime IN ('image/jpeg','image/png')),
 content_md5 text NOT NULL CHECK(content_md5 ~ '^[A-Za-z0-9+/]{22}==$'),
 capability_hash text NOT NULL CHECK(capability_hash ~ '^[a-f0-9]{64}$'),expires_at timestamptz NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed')),created_at timestamptz NOT NULL DEFAULT now(),confirmed_at timestamptz
);
REVOKE ALL ON sql_practice_attachments FROM PUBLIC,edulab_sql_student_v1;
CREATE INDEX IF NOT EXISTS sql_practice_attachment_owner ON sql_practice_attachments(device_id,participant_id,round_id);
CREATE OR REPLACE FUNCTION edulab_local_backup.register_practice_attachment(p_device uuid,p_participant uuid,p_round uuid,p_submission uuid,p_id uuid,p_sha text,p_size int,p_mime text,p_cap text,p_md5 text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,edulab_local_backup AS $$
DECLARE snapshot jsonb; r jsonb; item jsonb; existing public.sql_practice_attachments%ROWTYPE; suffix text;
BEGIN
 IF p_md5 !~ '^[A-Za-z0-9+/]{22}==$' OR p_sha !~ '^[a-f0-9]{64}$' OR p_cap !~ '^[a-f0-9]{64}$' OR p_size NOT BETWEEN 1 AND 2097152 OR p_mime NOT IN ('image/jpeg','image/png') THEN RAISE EXCEPTION 'Invalid attachment';END IF;
 SELECT archive INTO snapshot FROM edulab_local_backup.latest_participants p WHERE p.device_id=p_device AND p.participant_id=p_participant AND archive->>'study_schema'='sql-teachable-mvp/1'
 AND NOT EXISTS(SELECT 1 FROM public.local_backup_dispositions d WHERE d.device_id=p.device_id AND d.participant_id=p.participant_id AND d.is_trashed);
 IF snapshot IS NULL THEN RAISE EXCEPTION 'Snapshot not synchronized';END IF;
 SELECT x INTO r FROM jsonb_array_elements(snapshot#>'{study,rounds}') x WHERE x->>'id'=p_round::text AND x->>'practice_start' IS NOT NULL;
 SELECT x INTO item FROM jsonb_array_elements(coalesce(snapshot#>'{study,practice_attachments}','[]'::jsonb)) x WHERE x->>'id'=p_id::text AND x->>'round_id'=p_round::text AND x->>'submission_id'=p_submission::text AND x->>'sha256'=p_sha AND x->>'content_md5'=p_md5 AND (x->>'size_bytes')::int=p_size AND x->>'mime'=p_mime AND coalesce(x->>'deleted','false')='false';
 IF r IS NULL OR item IS NULL THEN RAISE EXCEPTION 'Attachment ownership mismatch';END IF;
 suffix=p_device||'/'||p_participant||'/'||p_round||'/'||p_submission||'/'||p_id||CASE WHEN p_mime='image/png' THEN '.png' ELSE '.jpg' END;
 SELECT * INTO existing FROM public.sql_practice_attachments WHERE id=p_id FOR UPDATE;
 IF FOUND AND (existing.device_id<>p_device OR existing.participant_id<>p_participant OR existing.round_id<>p_round OR existing.submission_id<>p_submission OR existing.sha256<>p_sha OR existing.size_bytes<>p_size OR existing.mime<>p_mime OR existing.content_md5<>p_md5) THEN RAISE EXCEPTION 'Immutable attachment mismatch';END IF;
 INSERT INTO public.sql_practice_attachments(id,device_id,participant_id,round_id,submission_id,object_suffix,sha256,size_bytes,mime,content_md5,capability_hash,expires_at)
 VALUES(p_id,p_device,p_participant,p_round,p_submission,suffix,p_sha,p_size,p_mime,p_md5,p_cap,now()+interval '30 minutes')
 ON CONFLICT(id) DO UPDATE SET capability_hash=p_cap,expires_at=now()+interval '30 minutes';
 RETURN jsonb_build_object('id',p_id,'status',coalesce(existing.status,'pending'));
END;$$;
REVOKE ALL ON FUNCTION edulab_local_backup.register_practice_attachment(uuid,uuid,uuid,uuid,uuid,text,int,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION edulab_local_backup.register_practice_attachment(uuid,uuid,uuid,uuid,uuid,text,int,text,text,text) TO edulab_sql_student_v1;
