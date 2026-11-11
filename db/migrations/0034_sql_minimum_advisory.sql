-- Retain all existing student data, grades and group allocations.
DO $migration$
DECLARE old_row sql_study_control%ROWTYPE; cfg jsonb; new_revision int; common_text text;
BEGIN
 SELECT * INTO old_row FROM sql_study_control WHERE id='sql-teachable-mvp/1' FOR UPDATE;
 IF NOT FOUND THEN RETURN;END IF;
 INSERT INTO sql_study_versions(revision,prompt_version,config,summary) VALUES(old_row.revision,(old_row.config->>'prompt_version')::int,old_row.config,'["最低十轮与建议计时升级前配置已封存"]'::jsonb) ON CONFLICT DO NOTHING;
 cfg=old_row.config||jsonb_build_object('dialogue_policy','min10-advisory/1','timing_policy','advisory/1','max_questions',0,'minimum_student_version','0.14.0');
 cfg=jsonb_set(cfg,'{research}',$research${"version": "sql-lt/1.1", "preparation_grouped": true, "effort_version": "mental-effort-sql/1", "d1_version": "SQL-LT-D1/v1.1", "d1_delay_days": 7, "d1_window_days": 2, "minimum_turns": 10, "dialogue_policy": "min10-advisory/1"}$research$::jsonb);
 IF jsonb_array_length(cfg#>'{research_questions,4}')=6 THEN cfg=jsonb_set(cfg,'{research_questions,4}',(cfg#>'{research_questions,4}')||$extra$["如果结果多了一列，你会先核对哪部分？", "学生姓名相同能说明是同一个学生吗？请解释。", "请说明你会如何用一行实际结果检查列的含义。", "请按提交要求复述SQL、运行结果与核验说明分别记录什么。"]$extra$::jsonb);END IF;
 common_text=cfg#>>'{prompts,common}';
 IF position('【轮次与建议用时 min10-advisory/1】' in common_text)=0 THEN cfg=jsonb_set(cfg,'{prompts,common}',to_jsonb(common_text||E'\n'||$policy$【轮次与建议用时 min10-advisory/1】至少完成10轮有效交流才能主动结束，无轮次上限，所有时长仅作建议。10轮前若已核对某项，围绕当前知识范围的新边界、反例或核验依据深化，避免重复流程确认；10轮后由学生决定继续或结束。不要宣称因时间或轮次到达而关闭交流。$policy$));END IF;
 new_revision=old_row.revision+1;
 UPDATE sql_study_control SET config=cfg,revision=new_revision,updated_at=now() WHERE id=old_row.id;
 INSERT INTO sql_study_versions(revision,prompt_version,config,summary) VALUES(new_revision,(cfg->>'prompt_version')::int,cfg,'["准备课和正式课至少10轮有效对话，无上限；所有用时为建议；精神努力必答后进入实操；新版客户端即时备份、测试身份免等待分组"]'::jsonb);
 INSERT INTO sql_study_audit(id,action,payload) VALUES(gen_random_uuid(),'dialogue.minimum_advisory',jsonb_build_object('revision',new_revision,'dialogue_policy','min10-advisory/1','minimum_turns',10));
END;
$migration$;
