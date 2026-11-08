-- Enable the explicitly used single-person test, without changing formal grouping.
INSERT INTO sql_study_assignments(class_code,participant_name,group_code,pretest_score,pair_no,batch_id,method)
SELECT class_code,participant_name,'L',(archive->'study'->'pretest'->>'score')::numeric,NULL,gen_random_uuid(),'single_test_manual'
FROM (SELECT DISTINCT ON(class_code,participant_name) * FROM edulab_local_backup.latest_participants
 WHERE class_code='计网2543' AND participant_name='test' AND is_test AND archive->>'study_schema'='sql-teachable-mvp/1'
 ORDER BY class_code,participant_name,received_at DESC) p
WHERE archive->'study'->'pretest' IS NOT NULL AND archive->'study'->'pretest'<>'null'::jsonb
 AND archive->'study'->'meta_pre' IS NOT NULL AND archive->'study'->'meta_pre'<>'null'::jsonb
 AND jsonb_array_length(archive->'study'->'rounds')=0
ON CONFLICT(class_code,participant_name) DO NOTHING;
CREATE TABLE IF NOT EXISTS sql_study_versions(
 revision integer PRIMARY KEY,prompt_version integer NOT NULL,config jsonb NOT NULL,
 updated_at timestamptz,summary jsonb NOT NULL,created_by uuid REFERENCES admin_users(id)
);
-- Reconstruct only revisions and times that are actually present in the audit log.
INSERT INTO sql_study_versions(revision,prompt_version,config,updated_at,summary,created_by)
SELECT (payload->'before'->>'revision')::int+1,(payload->'after'->>'prompt_version')::int,payload->'after',created_at,
 coalesce(payload->'summary','["历史配置更新；可根据保留的配置快照核查"]'::jsonb),admin_id
FROM sql_study_audit WHERE action='control.save' AND payload->'before'->>'revision' IS NOT NULL
ON CONFLICT DO NOTHING;
INSERT INTO sql_study_versions(revision,prompt_version,config,updated_at,summary)
SELECT (a.payload->'before'->>'revision')::int,(a.payload->'before'->'config'->>'prompt_version')::int,a.payload->'before'->'config',m.created_at,'["课堂时长改为分钟制，实操自动解锁，固定开启云备份"]'::jsonb
FROM sql_study_audit a JOIN sql_study_audit m ON m.action='control.always_backup_and_minutes' AND m.payload->'after'=a.payload->'before'->'config'
WHERE a.action='control.save' ON CONFLICT DO NOTHING;
INSERT INTO sql_study_versions(revision,prompt_version,config,updated_at,summary)
SELECT 1,(payload->'before'->>'prompt_version')::int,payload->'before',NULL,'["初始试运行配置；早期更新时间未留存"]'::jsonb
FROM sql_study_audit WHERE action='control.always_backup_and_minutes' ORDER BY created_at LIMIT 1 ON CONFLICT DO NOTHING;
INSERT INTO sql_study_versions(revision,prompt_version,config,updated_at,summary)
SELECT revision,(config->>'prompt_version')::int,config,updated_at,'["迁移时保存的当前配置"]'::jsonb FROM sql_study_control ON CONFLICT DO NOTHING;
