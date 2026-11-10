"""Bounded dialogue and research measures. Existing snapshots remain immutable."""
import copy
import json
import time
from pathlib import Path

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
    return config

def prediction(data,Problem):
    value=data.get('predicted_score')
    skipped=data.get('prediction_skipped') is True
    if skipped and value is not None:raise Problem('预估分与暂不回答不能同时填写。')
    if not skipped and (type(value) not in (int,float) or not 0<=value<=100):raise Problem('请估计本次得分（0—100），或选择暂不回答。')
    return {'value':None if skipped else value,'status':'skipped' if skipped else 'answered','version':'predicted-score/1'}

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
                if self.activate_research(p):self.save(p)

        def enter(self,data):
            result=super().enter(data);p=self.get(result['id'])
            if self.activate_research(p):self.save(p);result={**self.public(p),'session_token':result['session_token']}
            return result

        def research_snapshot(self,r):
            if not enabled(r['config']):return None
            cfg=r['config']['research'];limit=cfg['preparation_turns'] if r['index']==4 else cfg['formal_turns']
            completed=sum(q.get('status')=='completed' and not q.get('closing') for q in r['requests'])
            pending=any(q.get('status')=='running' for q in r['requests'])
            deadline=r.get('teaching_deadline');now=self.clock()
            window_ended=deadline is not None and now>=deadline
            in_closing=deadline is not None and now>=deadline-cfg['closing_seconds']
            ended=r.get('dialogue_end')
            last=next((q for q in reversed(r['requests']) if q.get('status')=='completed'),None)
            can_close=not ended and not window_ended and (completed>=limit or in_closing) and not any(q.get('closing') and q.get('status') in ('completed','running') for q in r['requests']) and bool(last and not last.get('closing'))
            return {'version':VERSION,'completed_turns':completed,'max_turns':limit,'pending':pending,'window_ended':window_ended,
                'closing_period':in_closing,'closed':bool(ended) or window_ended,'end_reason':ended.get('reason') if ended else 'time_limit' if window_ended else None,
                'can_send':self.stage_started(r,'ai') and not self.stage_started(r,'practice') and not pending and not ended and not window_ended and (completed<limit or can_close),
                'closing_reply':can_close,'effort_due':self.stage_started(r,'ai') and window_ended and not r.get('mental_effort') and not self.stage_started(r,'practice'),
                'effort_done':r.get('mental_effort') is not None,'mental_effort':r.get('mental_effort')}

        def end_dialogue(self,p,r,reason,at=None):
            if not r.get('dialogue_end'):
                r['dialogue_end']={'reason':reason,'at':self.clock() if at is None else at,'version':VERSION}
                r['teaching_end']=r['dialogue_end']['at'];self.event(p,'dialogue_ended',lesson=r['index'],reason=reason)
                return True
            return False

        def public(self,p):
            changed=False
            for r in p['rounds']:
                if enabled(r['config']) and self.stage_started(r,'ai') and self.clock()>=r['teaching_deadline']:
                    changed=self.end_dialogue(p,r,'time_limit',r['teaching_deadline']) or changed
            if changed:self.save(p)
            out=super().public(p);out['research_version']=p.get('research_version');out['preparation_grouped']=enabled(self.config())
            out['prediction_enabled']=enabled(self.config());out['history_count']+=len(p.get('research_history',[]))
            for r in out['rounds']:
                original=self.round_for(p,r['id']);r['dialogue']=self.research_snapshot(original)
                if enabled(original['config']) and self.stage_started(original,'practice'):
                    r['messages']=[];r['requests']=[];r['chat_locked']=True
                r.pop('teacher_assessment',None)
            return out

        def gate(self,p,key):
            if enabled(self.config()) and key.startswith(('ai','practice','posttest')) and p.get('group') not in ('L','T'):
                return {'open':False,'reason':'请先完成基线测量并等待教师分组；准备课也按固定组别进行'}
            if enabled(self.config()) and key.startswith('ai'):
                current=next((x for x in p['rounds'] if str(x['index'])==key[-1]),None)
                rule=self.config()['schedules'].get(p['class_code'],{}).get(key,{})
                timing=self.config().get('preparation_timing',{}) if key[-1]=='4' else self.config()
                if p.get('test_lesson_control',{}).get('lesson')!=int(key[-1]) and not (current and self.stage_started(current,'ai')) and rule.get('open_at') is not None and self.clock()+self.remote_time_offset>=min(rule['open_at']+timing['teaching_seconds'],rule.get('close_at') or float('inf')):
                    return {'open':False,'reason':'共同教学徒时段已结束，请联系教师安排补做'}
            if key.startswith('practice'):
                r=next((r for r in p['rounds'] if str(r['index'])==key[-1]),None)
                if r and enabled(r['config']) and not self.stage_started(r,'practice') and self.clock()>=r.get('teaching_deadline',float('inf')) and not r.get('mental_effort'):
                    return {'open':False,'reason':'请先完成教学徒结束卡（可暂不回答精神努力题）'}
            return super().gate(p,key)

        def act(self,pid,action,data):
            with self.lock:
                p=self.get(pid)
                if self.activate_research(p):self.save(p)
                if action in ('finish_dialogue','mental_effort'):
                    r=self.round_for(p,data.get('round_id'))
                    if not enabled(r['config']) or not self.stage_started(r,'ai') or self.stage_started(r,'practice'):raise Problem('当前不是教学徒结束环节。',409)
                    if action=='finish_dialogue':
                        if pid in self.active:raise Problem('请等待学徒回复结束后再收束。',409)
                        if self.end_dialogue(p,r,'student_finished'):self.save(p)
                    else:
                        if self.clock()<r['teaching_deadline']:raise Problem('请在共同教学徒时段结束后填写。',409)
                        if r.get('mental_effort'):raise Problem('本课结束卡已经提交，不能覆盖。',409)
                        value=data.get('value');skip=data.get('skipped') is True
                        if (skip and value is not None) or (not skip and (type(value)!=int or not 1<=value<=9)):raise Problem('请选择1—9，或暂不回答。')
                        self.end_dialogue(p,r,'time_limit',r['teaching_deadline'])
                        r['mental_effort']={'value':None if skip else value,'status':'skipped' if skip else 'answered','version':r['config']['research']['effort_version'],
                            'asked_epoch':r['teaching_deadline'],'server_asked_epoch':r['teaching_deadline']+self.remote_time_offset,'server_submitted_epoch':self.clock()+self.remote_time_offset,'submitted_epoch':self.clock(),'at':stamp(),'lesson':r['index'],'stage':'teaching','analysis_phase':'preparation' if r['index']==4 else 'formal'}
                        self.event(p,'mental_effort_submitted',lesson=r['index'],status=r['mental_effort']['status']);self.save(p)
                    return self.public(p)
                if enabled(self.config()) and action in ('meta_pre','meta_post'):
                    self.require_gate(p,action)
                    if p.get(action) is not None:raise Problem('问卷已提交，不能覆盖。',409)
                    values=data.get('answers')
                    if not isinstance(values,list) or len(values)!=13 or any(v is not None and (type(v)!=int or not 1<=v<=5) for v in values):raise Problem('问卷须为13项，未答留空。')
                    m=[v for v in values[:7] if v is not None];e=[v for v in values[7:] if v is not None];start=p.get('measurement_starts',{}).get(action)
                    p[action]={'answers':values,'monitoring':sum(m)/len(m) if len(m)>=6 else None,'evaluation':sum(e)/len(e) if len(e)>=5 else None,'monitoring_n':len(m),'evaluation_n':len(e),'response_policy':'optional-items/1','status':'submitted',
                        'at':stamp(),'started_epoch':start,'finished_epoch':self.clock(),'elapsed_seconds':self.clock()-start if start is not None else None,'version':self.bank['meta_spec']['version'],'item_ids':self.bank['meta_spec']['item_ids'],'items':self.bank['meta'],'instruction':self.bank['meta_spec']['instruction'],'options':self.bank['meta_spec']['options']}
                    p.get('measurement_drafts',{}).pop(action,None);self.event(p,action);self.save(p);return self.public(p)
                pred=None
                if enabled(self.config()) and action=='pretest':
                    if p.get('pretest') is not None:raise Problem('前测已提交，不能修改预估分。',409)
                    pred=prediction(data,Problem)
                if action in ('new_round','start_teaching') and enabled(self.config()) and p.get('group') not in ('L','T'):raise Problem('准备课也需教师按基线完成分组。',409)
                if p['rounds'] and action=='submit_practice':
                    r=self.round_for(p,data.get('round_id'))
                    if enabled(r['config']):
                        if r.get('submission'):raise Problem('实操已提交，不能修改预估分。',409)
                        pred=prediction(data,Problem)
                result=super().act(pid,action,data)
                p=self.get(pid)
                if action=='new_round':
                    r=self.round_for(p,data.get('round_id'))
                    if enabled(r['config']):r.update(research_version=VERSION,group=p['group']);self.save(p)
                if action=='start_teaching':
                    r=self.round_for(p,data.get('round_id'))
                    if enabled(r['config']):
                        rule=self.config()['schedules'].get(p['class_code'],{}).get('ai'+str(r['index']),{})
                        start=rule.get('open_at') if rule.get('mode') in ('open','scheduled') and p.get('test_lesson_control',{}).get('lesson')!=r['index'] else None
                        if start is not None:
                            r['clock_offset_seconds']=self.remote_time_offset;r['classroom_window_start']=start;r['teaching_deadline']=min(start+r['config']['teaching_seconds'],rule.get('close_at') or float('inf'))-self.remote_time_offset
                        self.save(p)
                if pred is not None:
                    pred.update(submitted_epoch=self.clock(),server_submitted_epoch=self.clock()+self.remote_time_offset,at=stamp(),stage='pretest' if action=='pretest' else 'practice')
                    (p['pretest'] if action=='pretest' else self.round_for(p,data.get('round_id'))['submission'])['prediction']=pred
                    self.event(p,'predicted_score_recorded',stage=pred['stage'],status=pred['status']);self.save(p)
                return self.public(p)

        def prepare_research_chat(self,p,r):
            if not enabled(r['config']):return {}
            info=self.research_snapshot(r)
            if info['pending']:raise Problem('学徒仍在回复，请稍候。',409)
            if not info['can_send']:raise Problem('本课对话已收束，请整理记录并等待共同实操时间。',409)
            return {'closing':bool(info['closing_reply'] or info['closing_period'])}

        def finalize_research_result(self,p,r,req,result):
            if not enabled(r['config']):return result
            if req.get('closing') or self.clock()>=r['teaching_deadline']-r['config']['research']['closing_seconds']:
                reason='time_limit' if self.clock()>=r['teaching_deadline'] else 'turn_limit' if self.research_snapshot(r)['completed_turns']>=self.research_snapshot(r)['max_turns'] else 'closing_period'
                self.end_dialogue(p,r,reason,min(self.clock(),r['teaching_deadline']))
                req['closing']=True;req['closure_reason']=reason;req['response_kind']='closure'
                return {'reply':'这部分讲解已经保存。请按共同核对表整理已讲的内容，等待统一的独立实操时间。','target':result.get('target',0),'reason':'程序收束，不再发起新问题','knowledge':r['knowledge'],'source':'protocol-closure','transport':result.get('transport',{})}
            merged={**r.get('knowledge',{}),**result.get('knowledge',{})}
            result['knowledge']=merged
            complete=all(isinstance(merged.get(str(i)),dict) and merged[str(i)].get('status')=='explained' for i in range(6))
            if complete:
                result['reply']='这些讲解已经记录。可以继续补充尚未说明的内容，或结束对话并整理核对表。'
                req['response_kind']='coverage_acknowledgement'
            elif r['group']=='T':
                result['reply']=r['config']['research_questions'][r['index']][req['turn_index']-1]
                result['target']=(req['turn_index']-1)%6
                result['reason']='程序按有限序列选择实际问题；模型状态仅作为解释记录。'
                req['response_kind']='fixed_question'
            else:req['response_kind']='adaptive_reply'
            return result

    return ResearchStore
