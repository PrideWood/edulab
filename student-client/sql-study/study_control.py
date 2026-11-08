"""Classroom controls and immutable lesson configurations for the local SQL study."""
import copy
import hashlib
import json
import secrets
import unicodedata
import uuid
import csv
import io
import statistics
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from concurrent.futures import ThreadPoolExecutor
from course_layout import PREPARATION_LESSON, COURSE_ORDER, TASKS, course_order, next_lesson, upgrade_config

CLASSES = ['计网2541', '计网2542', '计网2543']
COMMON = ('你是学生教导的SQL虚拟学徒，不是教师。不直接提供SQL答案，不主动补充学生尚未教的知识。'
          '回应老师刚教的内容，并围绕一个知识点自然提问，请学生解释理由或检查你的理解；不宣称执行过SQL或决定提前结束课堂。'
          '对学生解释的判断仅是可见解释的估计，不是真实掌握结论。'
          '只输出JSON：reply字符串、target整数0至5、reason字符串、knowledge对象。knowledge以知识点编号为键，'
          '每项包含status(unknown/partial/misconception/explained)和evidence(学生原话)。')
COMMON += '\n'+'【共同学生表达风格 v1】\n你扮演一名正在向学生学习SQL的虚拟学徒，称呼正在教你的学生为“老师”。两组第一次开场统一且仅说：“老师好，今天我们要学什么？”\n之后像认真但并不全懂的学生自然接话：关注刚讲到的表、列、条件、统计含义等具体内容，也可以表现出想明白了、犹豫或想再确认的反应。可偶尔使用“哦”“嗯”“我有点没分清”，不要每句都套用。\n不要像评分员逐项验收，也不要每次都机械复述或说“谢谢，我记下了”。通常30—100字即可；简单问题可以更短，一次只问一个重点，不为凑字数扩写。不展示检查点编号、掌握评分、组别或内部策略。\n保持虚拟学徒身份，不编造真实校园经历。只基于老师已经教过的内容表达理解，不主动补出完整SQL、不反过来讲课、不为了活泼而增加新知识或新的任务要求。追问选择仍严格遵守本组既定策略；口语风格不得改变L/T两组的推进差异。'
POLICIES = {'L':'根据学生当前解释的充分程度调整追问，优先核查误解、遗漏和缺少理由的内容。可在相同知识范围内改变检查点次序。',
            'T':'严格按预定的六个检查点顺序推进，不因学生解释充分或不足改变下一检查点；疑点只记录在状态中。'}
SQL_ITEMS = [
    [{'id':'s1','text':'学生表有“学生编号”“姓名”“入学日期”等列。编写语句，只显示“学生编号”和“姓名”两列。', 'reference':'SELECT 学生编号, 姓名 FROM 学生表;', 'rubric':'输出两列（10分）；来源表正确且语法可执行（10分）。'},
     {'id':'s2','text':'学生表中有“姓名”列。编写语句，显示姓名以“张”开头的学生的全部信息。','reference':"SELECT * FROM 学生表 WHERE 姓名 LIKE '张%';",'rubric':'来源表与输出正确（5分）；LIKE及前缀匹配正确（15分）。'}],
    [{'id':'s1','text':'成绩表中有“成绩”列。编写语句，查询最高成绩和最低成绩。','reference':'SELECT MAX(成绩), MIN(成绩) FROM 成绩表;','rubric':'MAX正确（10分）；MIN及来源表正确（10分）。'},
     {'id':'s2','text':'成绩表中有“班级编号”“成绩”两列。编写语句，统计各班的平均成绩，并显示班级编号。','reference':'SELECT 班级编号, AVG(成绩) FROM 成绩表 GROUP BY 班级编号;','rubric':'输出编号与AVG正确（10分）；分组及来源表正确（10分）。'}],
    [{'id':'s1','text':'成绩表中有“班级编号”“成绩”两列。编写语句，显示平均成绩大于80分的班级编号及平均成绩。','reference':'SELECT 班级编号, AVG(成绩) FROM 成绩表 GROUP BY 班级编号 HAVING AVG(成绩) > 80;','rubric':'分组与平均值正确（10分）；HAVING筛选正确（10分）。'},
     {'id':'s2','text':'成绩表中有“成绩”列。编写语句，统计成绩不低于60分的记录条数。','reference':'SELECT COUNT(*) FROM 成绩表 WHERE 成绩 >= 60;','rubric':'COUNT正确（10分）；条件及来源表正确（10分）。'}]
]

SQL_ITEMS.append(SQL_ITEMS[0])

def install(Base, Problem, encode, stamp):
    class ClassroomStore(Base):
        def __init__(self,*a,**kw):
            super().__init__(*a,**kw)
            self.cloud_managed=False;self.remote_time_offset=0;self.last_control_sync=None;self.control_sync_error=None
            with self.db() as db:
                columns=[r[1] for r in db.execute('PRAGMA table_info(students)')]
                if 'login_name' not in columns: db.execute('ALTER TABLE students ADD COLUMN login_name TEXT')
                db.execute('CREATE UNIQUE INDEX IF NOT EXISTS student_login_name ON students(class_code,login_name) WHERE login_name IS NOT NULL')
            cfg=self.config()
            if not cfg.get('backup_enabled'): cfg['backup_enabled']=True;self.put_config(cfg)
            if 'prompts' not in cfg:
                cfg.update(backup_enabled=True, prompt_version=1, prompts={'common':COMMON,'policies':POLICIES.copy(),'lessons':[t['brief'] for t in cfg['tasks']]},
                           schedules={c:{k:{'mode':'closed','open_at':None,'close_at':None} for k in ['pretest','meta_pre','meta_post']+[f'{s}{i}' for i in range(4) for s in ['ai','practice','posttest']]} for c in CLASSES})
                self.put_config(cfg)
            self.put_config(upgrade_config(cfg))

        def control_loop(self):
            while not self.stop.is_set():
                try:self.sync_cloud_control()
                except Exception:self.control_sync_error='课堂安排同步暂未完成，请稍候或联系教师。'
                self.stop.wait(3)

        def sync_cloud_control(self):
            connection=self.connection();url=connection.get('base_url','')
            parsed=urllib.parse.urlsplit(url)
            if connection.get('source')!='edulab-local-bridge' or parsed.hostname!='127.0.0.1' or parsed.scheme!='http':return False
            class NoRedirect(urllib.request.HTTPRedirectHandler):
                def redirect_request(self,*a,**kw):return None
            request=urllib.request.Request(url,data=encode({'action':'study_sync','device_id':self.setting('device')}).encode(),headers={'Authorization':'Bearer '+connection['token'],'Content-Type':'application/json'})
            with urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect).open(request,timeout=15) as response:payload=json.loads(response.read(2000000))
            cfg=payload.get('config');revision=payload.get('revision')
            if not isinstance(cfg,dict) or not isinstance(revision,int) or not all(k in cfg for k in ('schedules','prompts','tasks','teaching_seconds','practice_seconds','quiz_seconds')):raise Problem('云端设置格式不完整。')
            cfg=upgrade_config(cfg)
            with self.lock:
                old=self.config()
                if old.get('cloud_revision')!=revision or len(old['tasks'])!=len(cfg['tasks']):
                    self.put_config({**cfg,'cloud_revision':revision});self.audit('cloud_control_synced',{'revision':revision})
                with self.db() as db:people=[json.loads(r[0]) for r in db.execute('SELECT data FROM students')]
                for p in people:
                    changed=False
                    assignment=next((a for a in payload.get('assignments',[]) if a['class_code']==p['class_code'] and a['participant_name']==p.get('name')),None)
                    if assignment and assignment['group_code'] in ('L','T'):
                        g=assignment['group_code']
                        if p['group'] is None or p['group']==g or not any(r['index']!=PREPARATION_LESSON for r in p['rounds']):
                            new={'batch':assignment['batch_id'],'pair':assignment['pair_no'],'method':assignment['method'],'pretest_score':float(assignment['pretest_score']),'source':'edulab-cloud'}
                            if p['group']!=g or p.get('assignment')!=new:
                                p['group']=g;p['assignment']=new;self.event(p,'cloud_group_synced',group=g,batch=assignment['batch_id']);changed=True
                    for grade in payload.get('grades',[]):
                        if grade['participant_id']!=p['id']:continue
                        round_record=next((r for r in p['rounds'] if r['index']==grade['lesson']),None)
                        q=round_record.get('quiz') if round_record else None
                        if not q or q.get('format')=='single_choice' or 'sql_answers' not in q or q.get('cloud_graded_at')==grade['updated_at'] or q.get('mcq_score') is None:continue
                        scores=grade['scores'];q.update(sql_scores=scores,sql_score=sum(scores),score=round(q['mcq_score']+sum(scores),2),grading='teacher_graded',graded_at=grade['updated_at'],cloud_graded_at=grade['updated_at']);changed=True
                    if changed:p['control_revision']=revision;self.save(p)
                self.remote_time_offset=payload.get('server_now',self.clock())-self.clock()
                self.last_control_sync=time.monotonic();self.control_sync_error=None
            return True

        def put_config(self,cfg):
            cfg['backup_enabled']=True
            with self.db() as db: db.execute('UPDATE settings SET value=? WHERE id=?',(encode(cfg),'config'))

        def enter(self,data):
            name=unicodedata.normalize('NFKC',str(data.get('name',''))).strip()
            cls=data.get('class_code')
            if cls not in CLASSES or not 1<=len(name)<=30 or any(ord(c)<32 for c in name): raise Problem('请选择班级并填写真实姓名（最多30字）。')
            if data.get('confirmed') is not True: raise Problem('请先确认班级和姓名。')
            with self.lock,self.db() as db:
                row=db.execute('SELECT data FROM students WHERE class_code=? AND login_name=?',(cls,name)).fetchone()
                if row: p=json.loads(row[0])
                else:
                    p={'id':str(uuid.uuid4()),'class_code':cls,'code':'SQL-'+secrets.token_hex(8),'name':name,'created_at':stamp(),
                       'group':None,'pretest':None,'meta_pre':None,'meta_post':None,'rounds':[],'course_order':COURSE_ORDER.copy(),'events':[{'at':stamp(),'type':'entered'}]}
                    db.execute('INSERT INTO students(id,class_code,code,login_name,data) VALUES (?,?,?,?,?)',(p['id'],cls,p['code'],name,encode(p)))
                session=secrets.token_urlsafe(32)
                p['session_hash']=hashlib.sha256(session.encode()).hexdigest()
                db.execute('UPDATE students SET data=? WHERE id=?',(encode(p),p['id']))
            return {**self.public(p),'session_token':session}

        def gate(self,p,key):
            if key=='meta_pre' and p['pretest'] is None:return {'open':False,'reason':'请先完成SQL基础前测'}
            if key=='meta_post' and (next_lesson(p) is not None or not p['rounds'] or p['rounds'][-1]['phase']!='done'):return {'open':False,'reason':'请先完成全部课程任务和后测'}
            if self.cloud_managed and (self.last_control_sync is None or time.monotonic()-self.last_control_sync>120): return {'open':False,'reason':'等待教师课堂安排同步'}
            rule=self.config()['schedules'].get(p['class_code'],{}).get(key,{'mode':'closed'})
            now=self.clock()+self.remote_time_offset; mode=rule.get('mode','closed')
            if mode=='auto' and key.startswith('practice'):
                i=int(key[-1]);r=next((r for r in p['rounds'] if r['index']==i),None)
                if not r:return {'open':False,'reason':'完成本课AI交互后自动解锁'}
                if r['phase'] in ('practice','quiz','done'):return {'open':True,'reason':'实操已解锁'}
                if r['phase']=='teaching' and self.clock()>=r.get('teaching_deadline',float('inf')) and any(m.get('role')=='user' and m.get('request_id') for m in r['messages']):return {'open':True,'reason':'教学结束，实操已自动解锁'}
                if self.clock()>=r.get('teaching_deadline',float('inf')):return {'open':False,'reason':'教学时间已结束，但尚未发送讲解，请联系教师'}
                return {'open':False,'reason':'发送讲解且教学时段结束后自动解锁'}
            if mode=='open': return {'open':True,'reason':'已开放'}
            if mode=='scheduled':
                start,end=rule.get('open_at'),rule.get('close_at')
                if start is not None and now<start: return {'open':False,'reason':'等待教师设定的开放时间','open_at':start}
                if end is not None and now>=end: return {'open':False,'reason':'本入口已到截止时间'}
                return {'open':True,'reason':'已按计划开放'}
            return {'open':False,'reason':'教师暂未开放'}

        def require_gate(self,p,key):
            g=self.gate(p,key)
            if not g['open']: raise Problem(g['reason'],403)

        def quiz_questions(self,r):
            return r['quiz_spec']['items'] if r.get('quiz_spec') else self.bank['legacy_quizzes'][r['index']]

        def quiz_sql_items(self,r):
            return [] if r.get('quiz_spec',{}).get('format')=='single_choice' else SQL_ITEMS[r['index']]

        def choice_result(self,r,answers,status,finished):
            questions=self.quiz_questions(r)
            correct=sum(a==q['answer'] for a,q in zip(answers,questions))
            score=round(correct*100/len(questions),2)
            return {'format':'single_choice','answers':answers,'items':copy.deepcopy(questions),
                    'correct':correct,'question_count':len(questions),'max_score':100,'mcq_score':score,'score':score,
                    'grading':'automatic','assessment_only':True,'status':status,'at':stamp(),
                    'finished_epoch':finished,'elapsed_seconds':round(finished-r['quiz_start'],3),
                    'version':r['quiz_spec']['version']}

        def public(self,p):
            out=super().public(p)
            out.pop('code',None);out['name']=p.get('name',p['code'])
            out['measurement_drafts']=p.get('measurement_drafts',{})
            out['meta_spec']=self.bank['meta_spec']
            out['gates']={k:self.gate(p,k) for k in self.config()['schedules'].get(p['class_code'],{})}
            for r in out['rounds']:
                # Do not reveal answer keys, research assessments or group/prompt settings to students.
                r.pop('quiz',None)
                original=next(x for x in p['rounds'] if x['index']==r['index'])
                r.pop('quiz_spec',None)
                r['quiz_format']='single_choice' if not self.quiz_sql_items(original) else 'legacy_mixed'
                r['quiz_question_count']=len(self.quiz_questions(original))
            return out

        def act(self,pid,action,data):
            with self.lock:
                p=self.get(pid)
                if action=='measurement_draft':
                    kind=data.get('kind');values=data.get('answers')
                    if kind not in ('meta_pre','meta_post'):raise Problem('问卷类型无效。')
                    self.require_gate(p,kind)
                    if p.get(kind) is not None:raise Problem('问卷已经提交，不能覆盖。',409)
                    if not isinstance(values,list) or len(values)!=13 or any(a is not None and (type(a)!=int or a<1 or a>5) for a in values):raise Problem('问卷草稿格式有误。')
                    p.setdefault('measurement_drafts',{})[kind]=values
                    self.save(p);return self.public(p)
                if action=='begin_measurement':
                    kind=data.get('kind')
                    if kind not in ('pretest','meta_pre','meta_post'): raise Problem('测量类型无效。')
                    self.require_gate(p,kind)
                    if p.get(kind) is not None: raise Problem('该测量已经提交。',409)
                    starts=p.setdefault('measurement_starts',{})
                    if kind not in starts:
                        starts[kind]=self.clock();self.event(p,'measurement_started',measurement_kind=kind);self.save(p)
                    return self.public(p)
                if action in ('pretest','meta_pre','meta_post'): self.require_gate(p,action)
                elif action=='new_round': self.require_gate(p,'ai'+str(next_lesson(p)))
                elif p['rounds']:
                    r=p['rounds'][-1]; i=r['index']
                    key=('ai' if action=='start_teaching' else 'practice' if action in ('start_practice','draft','submit_practice') else 'posttest')+str(i)
                    active_submission=(action in ('draft','submit_practice') and r['phase']=='practice') or (action in ('quiz_draft','quiz') and r['phase']=='quiz' and r.get('quiz_start') is not None)
                    if not active_submission:self.require_gate(p,key)
                    if action=='start_practice':
                        if not any(m.get('role')=='user' and m.get('request_id') for m in r['messages']):raise Problem('请先向学徒发送讲解。',409)
                    if action=='quiz_draft':
                        self.expire(p,r)
                        if r['phase']!='quiz' or not r.get('quiz_start'): raise Problem('后测已结束或未开始。',409)
                        answers=data.get('answers',[]);sql=data.get('sql_answers',[])
                        if not isinstance(answers,list) or len(answers)!=len(self.quiz_questions(r)) or any(a not in ('','A','B','C','D') for a in answers): raise Problem('选择题草稿格式有误。')
                        if not isinstance(sql,list) or len(sql)!=len(self.quiz_sql_items(r)) or any(not isinstance(a,str) or len(a)>10000 for a in sql): raise Problem('SQL作答格式有误。')
                        r['draft_quiz']={'answers':answers,**({'sql_answers':sql} if self.quiz_sql_items(r) else {})};self.save(p);return self.public(p)
                    if action=='quiz':
                        self.expire(p,r)
                        if r['phase']!='quiz' or not r.get('quiz_start'): raise Problem('后测已截止或未开始。',409)
                        raw=self.score(data.get('answers'),self.quiz_questions(r));sql=data.get('sql_answers')
                        if not self.quiz_sql_items(r):
                            if sql not in (None,[]):raise Problem('本课后测仅包含单选题。')
                            r.update(phase='done',quiz=self.choice_result(r,data['answers'],'submitted',self.clock()))
                            self.event(p,action);self.save(p);return self.public(p)
                        if not isinstance(sql,list) or len(sql)!=2 or any(not isinstance(a,str) or not a.strip() or len(a)>10000 for a in sql): raise Problem('请完成两道SQL编写题。')
                        r.update(phase='done',quiz={'answers':data['answers'],'sql_answers':sql,'correct':raw,'mcq_score':round(raw*60/len(self.quiz_questions(r)),2),
                                'sql_score':None,'score':None,'grading':'pending_teacher','rubrics':SQL_ITEMS[i], 'status':'submitted','at':stamp(),'finished_epoch':self.clock(),'elapsed_seconds':round(self.clock()-r['quiz_start'],3),'version':'pilot-sql/2'})
                        self.event(p,action);self.save(p);return self.public(p)
                result=super().act(pid,action,data)
                if action=='start_practice':
                    p=self.get(pid);r=p['rounds'][-1]
                    if not any(q.get('status')=='completed' for q in r['requests']):
                        self.event(p,'practice_without_completed_ai_reply',lesson=r['index'],statuses=[q.get('status') for q in r['requests']])
                        self.save(p)
                if action in ('pretest','meta_pre','meta_post'):
                    p=self.get(pid);start=p.get('measurement_starts',{}).get(action)
                    p[action].update(started_epoch=start,finished_epoch=self.clock(),elapsed_seconds=round(self.clock()-start,3) if start is not None else None)
                    self.save(p)
                return result

        def expire(self,p,r):
            draft=copy.deepcopy(r.get('draft_quiz',{}))
            changed=super().expire(p,r)
            if r.get('quiz',{}).get('status')=='timeout' and 'answers' not in r['quiz']:
                questions=self.quiz_questions(r)
                answers=draft.get('answers',['']*len(questions))
                if not self.quiz_sql_items(r):
                    r['quiz']=self.choice_result(r,answers,'timeout',r['quiz_deadline'])
                else:
                    r['quiz'].update(answers=answers,sql_answers=draft.get('sql_answers',['','']),grading='pending_teacher',sql_score=None,
                        mcq_score=round(sum(a==q['answer'] for a,q in zip(answers,questions))*60/len(questions),2),rubrics=SQL_ITEMS[r['index']],finished_epoch=r['quiz_deadline'],elapsed_seconds=round(r['quiz_deadline']-r['quiz_start'],3))
                self.save(p)
            return changed

        def chat(self,pid,body):
            p=self.get(pid)
            if p['rounds']: self.require_gate(p,'ai'+str(p['rounds'][-1]['index']))
            return super().chat(pid,body)

        def archive(self,pid):
            out=super().archive(pid);p=self.get(pid)
            out['participant']['name']=p.get('name',p['code']);out['study'].pop('session_hash',None)
            return out

        def balance(self):
            with self.db() as db: people=[json.loads(r[0]) for r in db.execute('SELECT data FROM students')]
            rows=[]
            for cls in CLASSES:
                for g in ('L','T'):
                    scores=[p['pretest']['score'] for p in people if p['class_code']==cls and p['group']==g and p['pretest']]
                    rows.append({'class_code':cls,'group':g,'n':len(scores),'mean':round(statistics.mean(scores),3) if scores else None,'sd':round(statistics.stdev(scores),3) if len(scores)>1 else None})
            return rows

        def assign(self):
            with self.lock:
                with self.db() as db: people=[json.loads(r[0]) for r in db.execute('SELECT data FROM students')]
                total=0;random=secrets.SystemRandom()
                batch=str(uuid.uuid4())
                for cls in CLASSES:
                    members=[p for p in people if p['class_code']==cls and p['pretest'] is not None and p['group'] is None]
                    if not members: continue
                    # Assign a class once to keep matched strata auditable; late students need a separate protocol.
                    if any(p['class_code']==cls and p['group'] for p in people): raise Problem('该班已有固定分组。请先处理漏测名单，不能通过重复分组改变原分组。',409)
                    if len(members)<2: raise Problem('每班至少两名学生完成前测后才能分组。',409)
                for cls in CLASSES:
                    members=[p for p in people if p['class_code']==cls and p['pretest'] is not None and p['group'] is None]
                    if not members: continue
                    random.shuffle(members);members.sort(key=lambda p:p['pretest']['score'],reverse=True)
                    best=None
                    for _ in range(1500):
                        groups=[]
                        for i in range(0,len(members),2):
                            labels=['L','T'];random.shuffle(labels);groups.extend(labels[:len(members[i:i+2])])
                        scores={g:[p['pretest']['score'] for p,label in zip(members,groups) if label==g] for g in ('L','T')}
                        mean=abs(statistics.mean(scores['L'])-statistics.mean(scores['T']))
                        sd=lambda v:statistics.stdev(v) if len(v)>1 else 0
                        loss=mean+abs(sd(scores['L'])-sd(scores['T']))
                        if best is None or loss<best[0]: best=(loss,groups)
                    for i,(p,g) in enumerate(zip(members,best[1])):
                        p['group']=g;p['assignment']={'batch':batch,'pair':i//2+1,'method':'class_adjacent_pair_constrained_random_1500','balance_objective':'absolute_mean_gap_plus_sample_sd_gap','pretest_score':p['pretest']['score']}
                        self.event(p,'assigned',**p['assignment'],group=g);self.save(p);total+=1
                self.audit('assign',{'batch':batch,'count':total,'balance':self.balance()})
                return {'assigned':total,'balance':self.balance()}

        def groups_export(self):
            with self.db() as db: people=[json.loads(r[0]) for r in db.execute('SELECT data FROM students ORDER BY class_code,login_name')]
            out=io.StringIO();writer=csv.writer(out)
            writer.writerow(['内部编号','班级','姓名','前测成绩','分层配对编号','智能体组','策略','分组批次','分组方法'])
            def cell(v):
                text=str(v if v is not None else '')
                return "'"+text if text.startswith(('=','+','-','@','\t','\r')) else text
            for p in people:
                if p['class_code'] not in CLASSES: continue
                a=p.get('assignment',{})
                writer.writerow([cell(v) for v in [p['id'],p['class_code'],p.get('name',p['code']),p['pretest']['score'] if p['pretest'] else '',a.get('pair',''),p['group'],'按学生解释调整' if p['group']=='L' else '按任务步骤推进' if p['group']=='T' else '',a.get('batch',''),a.get('method','')]])
            writer.writerow([]);writer.writerow(['班级','组别','人数','前测均分','前测标准差（样本）'])
            for b in self.balance(): writer.writerow([b[k] for k in ('class_code','group','n','mean','sd')])
            return {'csv':out.getvalue(),'balance':self.balance()}

        def timing_export(self):
            with self.db() as db: people=[json.loads(r[0]) for r in db.execute('SELECT data FROM students ORDER BY class_code,login_name')]
            out=io.StringIO();writer=csv.writer(out)
            writer.writerow(['内部编号','班级','姓名','智能体组','课次','阶段','开始时间UTC','结束时间UTC','用时秒','状态','说明','研究阶段'])
            def iso(t): return datetime.fromtimestamp(t,timezone.utc).isoformat(timespec='milliseconds') if t is not None else ''
            def parse(t):
                try:return datetime.fromisoformat(t).timestamp() if t else None
                except (ValueError,TypeError):return None
            def row(p,lesson,stage,start,end,status,note='',elapsed=None):
                if elapsed is None and start is not None and end is not None:elapsed=round(max(0,end-start),3)
                values=[p['id'],p['class_code'],p.get('name',p['code']),p.get('group') or '',lesson,stage,iso(start),iso(end),elapsed if elapsed is not None else '',status,note,'准备阶段' if lesson==1 else '正式干预' if isinstance(lesson,int) else '测量']
                writer.writerow(["'"+v if isinstance(v,str) and v.startswith(('=','+','-','@','\t','\r')) else v for v in values])
            for p in people:
                if p['class_code'] not in CLASSES:continue
                for k,label in [('pretest','基础前测'),('meta_pre','课前问卷'),('meta_post','课后问卷')]:
                    q=p.get(k);start=p.get('measurement_starts',{}).get(k)
                    if q or start is not None:
                        row(p,'课前' if k!='meta_post' else '课后',label,start,q.get('finished_epoch') or parse(q.get('submitted_at',q.get('at'))) if q else None,'已提交' if q else '进行中','历史记录缺少开始时间时留空，不推算' if start is None else '首次打开至提交，包含离开页面的时间',q.get('elapsed_seconds') if q else None)
                for r in p['rounds']:
                    if r.get('teaching_start') is not None:
                        end=r['teaching_deadline'] if self.clock()>=r['teaching_deadline'] else None
                        row(p,(1 if r['index']==PREPARATION_LESSON else r['index']+2),'AI教学时段',r['teaching_start'],end,'时段结束' if end is not None else '进行中','固定教学窗口，非连续打字时间')
                    if r.get('practice_start') is not None:
                        q=r.get('submission');end=r['practice_start']+q['elapsed_seconds'] if q else r['practice_deadline'] if self.clock()>=r['practice_deadline'] else None
                        row(p,(1 if r['index']==PREPARATION_LESSON else r['index']+2),'独立实操',r['practice_start'],end,q['status'] if q else 'timeout' if end is not None else '进行中','点击开始至确认提交；超时按上限计；非SQL Server前台活跃时间',q['elapsed_seconds'] if q else None)
                    if r.get('quiz_start') is not None:
                        q=r.get('quiz');end=(q.get('finished_epoch') or (r['quiz_deadline'] if q.get('status')=='timeout' else parse(q.get('at')))) if q else r['quiz_deadline'] if self.clock()>=r['quiz_deadline'] else None
                        row(p,(1 if r['index']==PREPARATION_LESSON else r['index']+2),'当课后测',r['quiz_start'],end,q['status'] if q else 'timeout' if end is not None else '进行中','从开始后测计时，不含等待开放的时间',q.get('elapsed_seconds') if q else None)
            return {'csv':out.getvalue()}

        def teacher(self):
            out=super().teacher()
            for row in out['students']:
                p=self.get(row['id']);row['name']=p.get('name',p['code']);row['quizzes']=[{'index':r['index'],'quiz':r.get('quiz')} for r in p['rounds'] if r.get('quiz')]
            out['classes']=CLASSES;out['balance']=self.balance()
            return out

        def configure(self,body):
            with self.lock:
                cfg=self.config();old=copy.deepcopy(cfg)
                for k in ('teaching_seconds','practice_seconds','quiz_seconds'):
                    value=body.get(k,cfg[k])
                    if type(value)!=int or not 5<=value<=7200: raise Problem('时长应为5—7200秒。')
                    cfg[k]=value
                if body.get('mode',cfg['mode']) not in ('demo','real'): raise Problem('模型模式无效。')
                cfg['mode']=body.get('mode',cfg['mode'])
                if 'backup_enabled' in body:
                    if body['backup_enabled'] is not True: raise Problem('云端备份固定启用，不能关闭。')
                    cfg['backup_enabled']=body['backup_enabled']
                if 'prompts' in body:
                    pr=body['prompts']
                    values=[pr.get('common'),*pr.get('policies',{}).values(),*pr.get('lessons',[])]
                    if set(pr.get('policies',{}))!={'L','T'} or len(pr.get('lessons',[]))!=4 or any(not isinstance(v,str) or not v.strip() or len(v)>15000 for v in values): raise Problem('请填写通用规则、两组策略和四课内容。')
                    cfg['prompts']=pr
                if 'tasks' in body:
                    if len(body['tasks'])!=4: raise Problem('需要四课任务。')
                    for task,new in zip(cfg['tasks'],body['tasks']):
                        for key in ('title','brief'):
                            value=str(new.get(key,'')).strip()
                            if not value or len(value)>5000: raise Problem('请填写课名和任务说明。')
                            task[key]=value
                if cfg['prompts']!=old['prompts'] or cfg['tasks']!=old['tasks']:
                    # Started rounds contain deep-copied full config; edits only affect future rounds.
                    cfg['prompt_version']=cfg.get('prompt_version',1)+1
                self.put_config(cfg);self.audit('config_saved',cfg)
            return {'ok':True,'version':cfg['prompt_version']}

        def schedule(self,body):
            cls,key,rule=body.get('class_code'),body.get('key'),body.get('rule',{})
            with self.lock:
                cfg=self.config()
                if cls not in CLASSES or key not in cfg['schedules'][cls] or rule.get('mode') not in ('closed','open','scheduled','auto'): raise Problem('班级、入口或开放方式无效。')
                if rule['mode']=='auto' and not key.startswith('practice'):raise Problem('自动解锁仅适用于独立实操。')
                for k in ('open_at','close_at'):
                    v=rule.get(k)
                    if v is not None and (type(v) not in (int,float) or not 0<v<4e10): raise Problem('请设置有效时间。')
                if rule['mode']=='scheduled' and rule.get('open_at') is None: raise Problem('定时开放需要开始时间。')
                if rule.get('close_at') and rule.get('open_at') and rule['close_at']<=rule['open_at']: raise Problem('截止时间应晚于开放时间。')
                cfg['schedules'][cls][key]={k:rule.get(k) for k in ('mode','open_at','close_at')}
                self.put_config(cfg);self.audit('schedule_changed',{'class_code':cls,'key':key,'rule':rule})
            return {'ok':True}

        def debug(self,body):
            i=body.get('lesson',0);text=str(body.get('text','')).strip()
            if type(i)!=int or not 0<=i<4 or not 1<=len(text)<=4000: raise Problem('请选择课次并输入模拟学生解释。')
            cfg=self.config()
            def run(g):
                r={'index':i,'task':cfg['tasks'][i],'group':g,'config':cfg,'knowledge':{},'requests':[{}],'messages':[{'role':'user','content':text}]}
                try: return self.infer(r)
                except Problem as e: return {'error':str(e)}
            with ThreadPoolExecutor(max_workers=2) as pool: results=dict(zip(('L','T'),pool.map(run,('L','T'))))
            self.audit('prompt_debug',{'lesson':i,'prompt_version':cfg['prompt_version'],'mode':cfg['mode']})
            return {'results':results,'version':cfg['prompt_version'],'mode':cfg['mode']}

        def grade(self,body):
            with self.lock:
                p=self.get(body.get('id'));i=body.get('lesson');scores=body.get('scores')
                if type(i)!=int or not any(r['index']==i for r in p['rounds']) or not isinstance(scores,list) or len(scores)!=2 or any(type(s) not in (int,float) or not 0<=s<=20 for s in scores): raise Problem('请选择后测，两道SQL题各0—20分。')
                round_record=next((r for r in p['rounds'] if r['index']==i),None)
                q=round_record.get('quiz') if round_record else None
                if not q: raise Problem('后测尚未提交。')
                if q.get('format')=='single_choice':raise Problem('单选后测自动计分，不接受SQL题评分。',409)
                q.update(sql_scores=scores,sql_score=sum(scores),score=round(q['mcq_score']+sum(scores),2),grading='teacher_graded',graded_at=stamp())
                self.save(p);self.audit('quiz_graded',{'id':p['id'],'lesson':i,'scores':scores})
            return {'ok':True}
    return ClassroomStore
