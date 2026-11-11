"""Current-task access replaces every calendar gate in the active protocol."""
import re
POLICY='current-task/1'
def current_lesson(config,p):
    return p.get('test_lesson_control',{}).get('lesson',config.get('current_lessons',{}).get(p['class_code'],4))
def gate(store,p,key):
    cfg=store.config()
    if p['class_code'] not in store.active_classes():return {'open':False,'reason':'班级已停用，请联系教师'}
    if store.cloud_managed and (store.last_control_sync is None or __import__('time').monotonic()-store.last_control_sync>120):return {'open':False,'reason':'等待当前任务同步'}
    def result(value,reason):return {'open':bool(value),'reason':reason}
    if key=='pretest':return result(True,'可完成基础前测')
    if key=='meta_pre':return result(p.get('pretest') is not None,'请先完成SQL基础前测' if p.get('pretest') is None else '可填写课前问卷')
    if key=='meta_post':return result(current_lesson(cfg,p)==3 and any(r['index']==3 and r.get('quiz') for r in p['rounds']),'完成当前最后一课后填写课后问卷')
    m=re.fullmatch(r'(ai|practice|posttest)([0-4])',key)
    if not m:return result(False,'入口不存在')
    stage,i=m.group(1),int(m.group(2))
    if i!=current_lesson(cfg,p):return result(False,'当前只开放本次任务')
    if p.get('pretest') is None:return result(False,'请先完成SQL基础前测')
    if p.get('meta_pre') is None:return result(False,'请先完成13题课前问卷')
    if p.get('group') not in ('L','T'):return result(False,'请等待教师完成前测分组')
    r=next((r for r in p['rounds'] if r['index']==i),None)
    if stage=='ai':return result(not(r and store.stage_started(r,'practice')),'独立实操已开始，学徒入口已关闭' if r and store.stage_started(r,'practice') else '可进入本次教学徒任务')
    if stage=='practice':
        if r and store.stage_started(r,'practice'):return result(True,'可继续本次实操')
        if not r or not store.stage_started(r,'ai') or not any(m.get('role')=='user' for m in r['messages']):return result(False,'请先发送本课讲解')
        from dialogue_policy import completed_turns
        if completed_turns(r)<10:return result(False,'请至少完成10轮有效对话')
        if any(q.get('status')=='running' for q in r['requests']):return result(False,'请等待学徒回复完成')
        if not r.get('dialogue_end'):return result(False,'请主动结束本课对话')
        if not r.get('mental_effort'):return result(False,'请先完成教学徒结束卡')
        return result(True,'可开始独立实操')
    return result(bool(r and r.get('submission')),'请先提交本课独立实操' if not(r and r.get('submission')) else '可完成本次测评')
