"""Minimum exchanges and advisory timing; completed snapshots remain immutable."""
import copy
import json
import time
import unicodedata
from task_access import POLICY as ACCESS_POLICY,current_lesson
from pathlib import Path
from dialogue_policy import POLICY as DIALOGUE_POLICY,MINIMUM_TURNS,completed_turns,upgrade_round
from teaching_clock import POLICY as CLOCK_POLICY,ensure_clock,tick_clock,presence as clock_presence,status as clock_status

DEFAULTS=json.loads((Path(__file__).parent/'research_defaults.json').read_text(encoding='utf-8'))
VERSION=DEFAULTS['research']['version']

def enabled(config):
    return config.get('research',{}).get('version')==VERSION

def upgrade_config(config):
    if not enabled(config):
        config.update(copy.deepcopy({k:DEFAULTS[k] for k in ('research','research_questions')}))
        config['prompts']['common']=config['prompts']['common'].replace('回应老师刚教的内容，并围绕一个知识点自然提问，请学生解释理由或检查你的理解；','回应老师刚教的内容；确有待核查内容时，再请学生解释理由或检查你的理解；')+DEFAULTS['common_add']
        config['prompts']['preparation']=DEFAULTS['preparation_scope']
        config['prompts']['policies']['T']='按照程序给出的有限问题序列推进，不因解释质量改变次序，已经说清的内容简短确认；不无限循环。'
    config['research']=copy.deepcopy(DEFAULTS['research'])
    if '【轮次与建议用时 min10-advisory/1】' not in config['prompts']['common']:config['prompts']['common']+='\n【轮次与建议用时 min10-advisory/1】'+DEFAULTS['common_add'].split('【轮次与建议用时 min10-advisory/1】')[-1]
    config['max_questions']=0
    if len(config['research_questions'][4])<10:config['research_questions'][4]+=copy.deepcopy(DEFAULTS['research_questions'][4][len(config['research_questions'][4]):])
    config['dialogue_policy']=DIALOGUE_POLICY
    config['timing_policy']='advisory/1'
    config['measurement_policy']='required-no-prediction/1'
    config.setdefault('access_policy',ACCESS_POLICY)
    config.setdefault('current_lessons',{c['code']:4 for c in config.get('classes',[])})
    config.setdefault('test_cleanup_epoch','sql-clean-20261110-01')
    return config

def install(Base,Problem,stamp):
    class ResearchStore(Base):
        def activate_research(self,p):
            if not enabled(self.config()) or p.get('research_version')==VERSION:return False
            # Existing baselines and immutable rounds are retained with provenance. No re-randomization.
            if p.get('rounds') or p.get('meta_post'):
                p.setdefault('research_history',[]).append({'archived_at':stamp(),'version':p.get('research_version','legacy-unbounded/1'),
                    'rounds':copy.deepcopy(p['rounds']),'meta_post':copy.deepcopy(p.get('meta_post')),'test_lesson_control':copy.deepcopy(p.get('test_lesson_control'))})
                p['prior_research_exposure']=any(r.get('messages') for r in p['rounds'])
                p['rounds']=[];p['meta_post']=None;p.pop('test_lesson_control',None)
                p.get('measurement_drafts',{}).pop('meta_post',None);p.get('measurement_starts',{}).pop('meta_post',None)
            p['research_version']=VERSION
            p['baseline_reused_from_prior_protocol']=bool(p.get('pretest') or p.get('meta_pre'))
            self.event(p,'research_protocol_activated',version=VERSION)
            return True

        def __init__(self,*args,**kwargs):
            super().__init__(*args,**kwargs)
            with self.db() as db:people=[json.loads(row[0]) for row in db.execute('SELECT data FROM students')]
            for p in people:
                changed=self.activate_research(p) or self.upgrade_individual_windows(p)
                for r in p['rounds']:
                    if r.get('teaching_clock') and not self.stage_started(r,'practice'):
                        r['teaching_clock'].update(active_until=self.clock(),accounted_at=self.clock(),view_id=None);tick_clock(r,self.clock());changed=True
                if changed:self.save(p)

        def enter(self,data):
            name=unicodedata.normalize('NFKC',str(data.get('name',''))).strip()
            epoch=self.config().get('test_cleanup_epoch')
            with self.lock,self.db() as db:
                row=db.execute('SELECT data FROM students WHERE class_code=? AND login_name=?',(data.get('class_code'),name)).fetchone()
                if row:
                    old=json.loads(row[0])
                    is_test=name.lower() in ('柴博泉','测试','test','ceshi') or old.get('test_lesson_control') or old.get('test_identity')
                    if epoch and is_test and (old.get('retired_by_cloud') or old.get('test_cleanup_epoch')!=epoch):
                        db.execute('CREATE TABLE IF NOT EXISTS retired_test_students(id TEXT PRIMARY KEY,data TEXT,retired_at TEXT)')
                        db.execute('INSERT OR IGNORE INTO retired_test_students VALUES(?,?,?)',(old['id'],row[0],stamp()))
                        db.execute("UPDATE backups SET status='retired' WHERE participant_id=?",(old['id'],))
                        db.execute('DELETE FROM students WHERE id=?',(old['id'],))
            result=super().enter(data);p=self.get(result['id'])
            if self.activate_research(p):self.save(p)
            p['test_cleanup_epoch']=epoch;p['client_version']='0.14.0';self.save(p)
            return {**self.public(p),'session_token':result['session_token']}

        def research_snapshot(self,r):
            if not enabled(r['config']):return None
            completed=completed_turns(r);pending=any(q.get('status')=='running' for q in r['requests'])
            ended=r.get('dialogue_end');now=self.clock();started=self.stage_started(r,'ai');practice=self.stage_started(r,'practice')
            return {'version':VERSION,'policy':DIALOGUE_POLICY,'completed_turns':completed,'minimum_turns':MINIMUM_TURNS,'max_turns':None,
                'pending':pending,'window_ended':False,'closing_period':False,'closed':bool(ended),'end_reason':ended.get('reason') if ended else None,
                'can_send':started and not practice and not pending and not ended,'can_finish':started and not practice and not pending and not ended and completed>=MINIMUM_TURNS,
                'remaining_turns':max(0,MINIMUM_TURNS-completed),'closing_reply':False,'effort_due':started and bool(ended) and completed>=MINIMUM_TURNS and not r.get('mental_effort') and not practice,
                'effort_done':r.get('mental_effort') is not None,'mental_effort':r.get('mental_effort'),'timing_policy':'advisory/1',**clock_status(r,now)}

        def end_dialogue(self,p,r,reason,at=None):
            if not r.get('dialogue_end'):
                r['dialogue_end']={'reason':reason,'at':self.clock() if at is None else at,'version':VERSION}
                r['teaching_end']=r['dialogue_end']['at'];self.event(p,'dialogue_ended',lesson=r['index'],reason=reason)
                return True
            return False

        def upgrade_individual_windows(self,p):
            changed=False
            for r in p['rounds']:
                if enabled(r['config']) and upgrade_round(r,self.clock()):changed=True
                if enabled(r['config']) and ensure_clock(r,self.clock()):
                    self.event(p,'teaching_clock_upgraded',lesson=r['index'],policy=CLOCK_POLICY);changed=True
            return changed

        def public(self,p):
            changed=self.upgrade_individual_windows(p)
            test=p.get('name','').strip().lower() in ('柴博泉','测试','test','ceshi') or p.get('test_identity') or p.get('test_lesson_control')
            if test and not p.get('retired_by_cloud') and p.get('group') not in ('L','T'):
                p.update(group='L',test_identity=True);self.event(p,'test_default_group_assigned',group='L');changed=True
            if p.get('client_version')!='0.14.0' or p.get('access_policy')!=ACCESS_POLICY:p.update(client_version='0.14.0',access_policy=ACCESS_POLICY,delivery_mode='local',measurement_policy='required-no-prediction/1',dialogue_policy=DIALOGUE_POLICY,timing_policy='advisory/1');changed=True
            for r in p['rounds']:
                if enabled(r['config']) and tick_clock(r,self.clock()):changed=True
            if changed:self.save(p)
            out=super().public(p);out['research_version']=p.get('research_version');out['preparation_grouped']=enabled(self.config())
            cfg=self.config();out['access_policy']=cfg.get('access_policy');out['current_lesson']=current_lesson(cfg,p);out['test_reset_required']=p.get('retired_by_cloud',False) or bool(cfg.get('test_cleanup_epoch') and p.get('test_cleanup_epoch')!=cfg['test_cleanup_epoch'] and (p.get('name','').strip().lower() in ('柴博泉','测试','test','ceshi') or p.get('test_identity') or p.get('test_lesson_control')))
            out['backup']=self.backup_status(p['id']);out['prediction_enabled']=False;out['history_count']+=len(p.get('research_history',[]))
            for r in out['rounds']:
                original=self.round_for(p,r['id']);r['dialogue']=self.research_snapshot(original)
                if enabled(original['config']) and self.stage_started(original,'practice'):
                    r['messages']=[];r['requests']=[];r['chat_locked']=True
                r.pop('teacher_assessment',None)
            return out

        def gate(self,p,key):
            if enabled(self.config()) and key.startswith(('ai','practice','posttest')) and p.get('group') not in ('L','T'):
                return {'open':False,'reason':'请先完成基线测量并等待教师分组；准备课也按固定组别进行'}
            if key.startswith('practice'):
                r=next((r for r in p['rounds'] if str(r['index'])==key[-1]),None)
                if r and enabled(r['config']) and not self.stage_started(r,'practice'):
                    if completed_turns(r)<MINIMUM_TURNS:return {'open':False,'reason':'请至少完成10轮有效对话'}
                    if any(q.get('status')=='running' for q in r['requests']):return {'open':False,'reason':'请等待学徒回复完成'}
                    if not r.get('dialogue_end'):return {'open':False,'reason':'达到10轮后，请主动结束对话'}
                    if not r.get('mental_effort'):return {'open':False,'reason':'请先完成教学徒结束卡'}
            result=super().gate(p,key)
            if enabled(self.config()) and key.startswith('ai') and result.get('reason')=='本入口已到截止时间':
                return {'open':True,'reason':'可开始本课，按个人开始时间计时'}
            return result

        def act(self,pid,action,data):
            with self.lock:
                p=self.get(pid)
                if action=='retry_backup':
                    self.retry_backup(pid);return self.public(p)
                if self.activate_research(p):self.save(p)
                changed=self.upgrade_individual_windows(p)
                for item in p['rounds']:
                    if enabled(item['config']):changed=tick_clock(item,self.clock()) or changed
                if changed:self.save(p)
                if self.config().get('access_policy')==ACCESS_POLICY and action in ('start_teaching','start_practice','draft','submit_practice','start_quiz','quiz','quiz_draft','finish_dialogue','mental_effort','teaching_presence'):
                    if self.round_for(p,data.get('round_id'))['index']!=current_lesson(self.config(),p):raise Problem('当前只能完成本次任务。',403)
                if action=='teaching_presence':
                    r=self.round_for(p,data.get('round_id'));view=data.get('view_id');sequence=data.get('sequence');active=data.get('active')
                    if not enabled(r['config']) or not r.get('teaching_clock') or self.stage_started(r,'practice'):raise Problem('当前不是教学徒计时阶段。',409)
                    if type(active)!=bool or not isinstance(view,str) or not 1<=len(view)<=80 or type(sequence)!=int or not 0<=sequence<=1000000000:raise Problem('页面计时信息无效。')
                    if clock_presence(r,self.clock(),active,view,sequence):self.save(p)
                    return self.public(p)
                if action in ('finish_dialogue','mental_effort'):
                    r=self.round_for(p,data.get('round_id'))
                    if not enabled(r['config']) or not self.stage_started(r,'ai') or self.stage_started(r,'practice'):raise Problem('当前不是教学徒结束环节。',409)
                    if action=='finish_dialogue':
                        if pid in self.active:raise Problem('请等待学徒回复结束后再收束。',409)
                        if completed_turns(r)<MINIMUM_TURNS:raise Problem('请至少完成10轮有效对话后再进入下一环节。',409)
                        if self.end_dialogue(p,r,'student_finished'):self.save(p)
                    else:
                        if completed_turns(r)<MINIMUM_TURNS or not r.get('dialogue_end') or pid in self.active:raise Problem('请至少完成10轮有效对话，主动结束后填写。',409)
                        if r.get('mental_effort'):raise Problem('本课结束卡已经提交，不能覆盖。',409)
                        value=data.get('value');skip=data.get('skipped') is True
                        if skip or type(value)!=int or not 1<=value<=9:raise Problem('请选择1—9，精神努力题必须作答。')
                        asked=r['dialogue_end']['at']
                        r['mental_effort']={'value':value,'status':'answered','response_policy':'required-items/1','version':r['config']['research']['effort_version'],
                            'asked_epoch':asked,'server_asked_epoch':asked+self.remote_time_offset,'server_submitted_epoch':self.clock()+self.remote_time_offset,'submitted_epoch':self.clock(),'at':stamp(),'lesson':r['index'],'stage':'teaching','analysis_phase':'preparation' if r['index']==4 else 'formal'}
                        self.event(p,'mental_effort_submitted',lesson=r['index'],status=r['mental_effort']['status']);self.save(p)
                    return self.public(p)
                if enabled(self.config()) and action in ('meta_pre','meta_post'):
                    self.require_gate(p,action)
                    if p.get(action) is not None:raise Problem('问卷已提交，不能覆盖。',409)
                    values=data.get('answers')
                    if not isinstance(values,list) or len(values)!=13 or any(type(v)!=int or not 1<=v<=5 for v in values):raise Problem('请完成全部13题，每题选择1—5，不能留空。')
                    m=[v for v in values[:7] if v is not None];e=[v for v in values[7:] if v is not None];start=p.get('measurement_starts',{}).get(action)
                    p[action]={'answers':values,'monitoring':sum(m)/len(m) if len(m)>=6 else None,'evaluation':sum(e)/len(e) if len(e)>=5 else None,'monitoring_n':len(m),'evaluation_n':len(e),'response_policy':'required-items/1','status':'submitted',
                        'at':stamp(),'started_epoch':start,'finished_epoch':self.clock(),'elapsed_seconds':self.clock()-start if start is not None else None,'version':self.bank['meta_spec']['version'],'item_ids':self.bank['meta_spec']['item_ids'],'items':self.bank['meta'],'instruction':self.bank['meta_spec']['instruction'],'options':self.bank['meta_spec']['options']}
                    p.get('measurement_drafts',{}).pop(action,None);self.event(p,action);self.save(p);return self.public(p)
                if action=='new_round' and self.config().get('access_policy')==ACCESS_POLICY and self.requested_lesson(p,data)!=current_lesson(self.config(),p):raise Problem('当前只能完成本次任务。',403)
                if action in ('new_round','start_teaching') and enabled(self.config()) and p.get('group') not in ('L','T'):raise Problem('准备课也需教师按基线完成分组。',409)
                result=super().act(pid,action,data)
                p=self.get(pid)
                if action=='new_round':
                    r=self.round_for(p,data.get('round_id'))
                    if enabled(r['config']):r.update(research_version=VERSION,group=p['group'],teaching_window_policy=CLOCK_POLICY);self.save(p)
                if action=='start_teaching':
                    r=self.round_for(p,data.get('round_id'))
                    if enabled(r['config']):
                        r['teaching_window_policy']=CLOCK_POLICY;self.save(p)
                return self.public(p)

        def prepare_research_chat(self,p,r):
            if not enabled(r['config']):return {}
            tick_clock(r,self.clock())
            info=self.research_snapshot(r)
            if info['pending']:raise Problem('学徒仍在回复，请稍候。',409)
            if not info['can_send']:raise Problem('本课对话已结束或已进入独立实操。',409)
            return {'closing':False}

        def finalize_research_result(self,p,r,req,result):
            if not enabled(r['config']):return result
            tick_clock(r,self.clock())
            merged={**r.get('knowledge',{}),**result.get('knowledge',{})}
            result['knowledge']=merged
            complete=all(isinstance(merged.get(str(i)),dict) and merged[str(i)].get('status')=='explained' for i in range(6))
            if complete and req['turn_index']>=MINIMUM_TURNS:
                result['reply']='这些讲解已经记录。可以继续补充尚未说明的内容，或结束对话并整理核对表。'
                req['response_kind']='coverage_acknowledgement'
            elif r['group']=='T':
                result['reply']=r['config']['research_questions'][r['index']][(req['turn_index']-1)%len(r['config']['research_questions'][r['index']])]
                result['target']=(req['turn_index']-1)%6
                result['reason']='程序按有限序列选择实际问题；模型状态仅作为解释记录。'
                req['response_kind']='fixed_question'
            else:req['response_kind']='adaptive_reply'
            return result

    return ResearchStore
