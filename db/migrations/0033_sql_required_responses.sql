-- Preserve historical responses; all newly submitted scales require complete answers.
DO $migration$
DECLARE old_row sql_study_control%ROWTYPE; next_config jsonb; next_revision int;
BEGIN
 SELECT * INTO old_row FROM sql_study_control WHERE id='sql-teachable-mvp/1' FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 INSERT INTO sql_study_versions(revision,prompt_version,config,summary) VALUES(old_row.revision,(old_row.config->>'prompt_version')::int,old_row.config,'["必答策略升级前配置已封存"]'::jsonb) ON CONFLICT DO NOTHING;
 next_config=(old_row.config #- '{research,prediction_version}')||jsonb_build_object('measurement_policy','required-no-prediction/1','minimum_student_version','0.13.0');
 next_config=jsonb_set(next_config,'{research,d1_version}','"SQL-LT-D1/v1.1"'::jsonb);next_revision=old_row.revision+1;
 UPDATE sql_study_control SET config=next_config,revision=next_revision,updated_at=now() WHERE id=old_row.id;
 INSERT INTO sql_study_versions(revision,prompt_version,config,summary) VALUES(next_revision,(next_config->>'prompt_version')::int,next_config,'["量表与测试题全部必答，精神努力不可跳过；移除所有成绩估算采集；D1材料更新至v1.1"]'::jsonb);
 INSERT INTO sql_study_audit(id,action,payload) VALUES(gen_random_uuid(),'measurement.required',jsonb_build_object('revision',next_revision,'policy','required-no-prediction/1'));
END;
$migration$;
