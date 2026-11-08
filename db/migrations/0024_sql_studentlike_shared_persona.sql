DO $$
DECLARE old_config jsonb;next_config jsonb;new_revision integer;prompt text;
BEGIN
 SELECT config INTO old_config FROM sql_study_control WHERE id='sql-teachable-mvp/1' FOR UPDATE;
 IF old_config IS NULL THEN RETURN; END IF;
 prompt=old_config->'prompts'->>'common';
 IF position('【共同学生表达风格 v1】' in prompt)>0 THEN RETURN; END IF;
 prompt=replace(replace(prompt,'每次回复80—180字。',''),'先简短复述，再提出一个问题','回应老师刚教的内容，并围绕一个知识点自然提问')||E'\n'||$persona$【共同学生表达风格 v1】
你扮演一名正在向学生学习SQL的虚拟学徒，称呼正在教你的学生为“老师”。两组第一次开场统一且仅说：“老师好，今天我们要学什么？”
之后像认真但并不全懂的学生自然接话：关注刚讲到的表、列、条件、统计含义等具体内容，也可以表现出想明白了、犹豫或想再确认的反应。可偶尔使用“哦”“嗯”“我有点没分清”，不要每句都套用。
不要像评分员逐项验收，也不要每次都机械复述或说“谢谢，我记下了”。通常30—100字即可；简单问题可以更短，一次只问一个重点，不为凑字数扩写。不展示检查点编号、掌握评分、组别或内部策略。
保持虚拟学徒身份，不编造真实校园经历。只基于老师已经教过的内容表达理解，不主动补出完整SQL、不反过来讲课、不为了活泼而增加新知识或新的任务要求。追问选择仍严格遵守本组既定策略；口语风格不得改变L/T两组的推进差异。$persona$;
 next_config=jsonb_set(old_config,'{prompts,common}',to_jsonb(prompt));
 next_config=jsonb_set(next_config,'{prompt_version}',to_jsonb((old_config->>'prompt_version')::int+1));
 UPDATE sql_study_control SET config=next_config,revision=revision+1,updated_at=now() WHERE id='sql-teachable-mvp/1' RETURNING revision INTO new_revision;
 INSERT INTO sql_study_versions(revision,prompt_version,config,updated_at,summary) VALUES(new_revision,(next_config->>'prompt_version')::int,next_config,now(),'["两组开场统一为：老师好，今天我们要学什么？","共同表达改为自然的学生语气；保留L/T推进差异，课堂内容不变"]'::jsonb);
 INSERT INTO sql_study_audit(id,action,payload) VALUES(gen_random_uuid(),'control.studentlike_persona',jsonb_build_object('revision',new_revision,'before',old_config,'after',next_config));
END $$;
