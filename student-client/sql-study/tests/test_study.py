import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
import urllib.error
from http.server import ThreadingHTTPServer
_http_open=urllib.request.build_opener(urllib.request.ProxyHandler({})).open
def local_open(req):return _http_open(req,timeout=5)
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store,Problem,Handler,encode
from study_control import CLASSES

class StudyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.clock=[1000.0]
        self.s=Store(self.tmp.name,clock=lambda:self.clock[0])
    def tearDown(self):self.s.stop.set();self.tmp.cleanup()
    def student(self,name='测试',cls=CLASSES[0]):
        return self.s.enter({'class_code':cls,'name':name,'confirmed':True})
    def open(self,key,mode='open',**extra):
        self.s.schedule({'class_code':CLASSES[0],'key':key,'rule':{'mode':mode,**extra}})
    def prepared(self,legacy_quiz=False):
        p=self.student();pid=p['id'];other=self.student('配对测试')['id']
        self.open('pretest');self.open('meta_pre')
        for who in (pid,other):
            self.s.act(who,'pretest',{'answers':[q['answer'] for q in self.s.bank['pretest']]})
        self.s.act(pid,'meta_pre',{'answers':[3]*13});self.s.assign()
        legacy=self.s.get(pid);legacy['course_order']=[0,1,2];self.s.save(legacy)
        for i in range(3):
            for key in ('ai','practice','posttest'):self.open(key+str(i))
        self.s.act(pid,'new_round',{});self.s.act(pid,'start_teaching',{})
        if legacy_quiz:
            p=self.s.get(pid);p['rounds'][-1].pop('quiz_spec');self.s.save(p)
        return pid
    def interact(self,pid):
        self.s.chat(pid,{'text':'从学生表选姓名列，并核对结果。','request_id':str(self.clock[0])})
        for _ in range(100):
            if pid not in self.s.active:break
            time.sleep(.01)
        self.assertEqual(self.s.get(pid)['rounds'][-1]['requests'][-1]['status'],'completed')
    def practice(self,pid):
        self.interact(pid);self.clock[0]+=901;self.s.act(pid,'start_practice',{})
        self.s.act(pid,'draft',{'sql':'SELECT 1;','result':'1'})
    def test_meta_requires_pretest_and_keeps_identity_version_and_drafts(self):
        pid=self.student()['id'];self.open('meta_pre');self.open('pretest')
        for action,body in [('begin_measurement',{'kind':'meta_pre'}),('meta_pre',{'answers':[3]*13}),('measurement_draft',{'kind':'meta_pre','answers':[None]*13})]:
            with self.assertRaises(Problem):self.s.act(pid,action,body)
        self.s.act(pid,'pretest',{'answers':['A']*20})
        self.s.act(pid,'begin_measurement',{'kind':'meta_pre'})
        self.s.act(pid,'measurement_draft',{'kind':'meta_pre','answers':[5]+[None]*12})
        self.assertEqual(self.s.state(pid)['measurement_drafts']['meta_pre'][0],5)
        self.clock[0]+=60
        self.s.act(pid,'meta_pre',{'answers':[5]*7+[2]*6})
        q=self.s.get(pid)['meta_pre'];self.assertEqual(q['monitoring'],5);self.assertEqual(q['evaluation'],2)
        self.assertEqual(q['elapsed_seconds'],60);self.assertEqual(q['items'],self.s.bank['meta'])
        self.assertEqual(q['version'],self.s.bank['meta_spec']['version'])
        a=self.s.archive(pid);self.assertEqual(a['participant']['id'],pid);self.assertEqual(a['study']['id'],pid)
        self.assertEqual(a['study']['meta_pre'],q)
        self.assertNotIn('meta_pre',self.s.state(pid)['measurement_drafts'])
        with self.assertRaises(Problem):self.s.act(pid,'meta_pre',{'answers':[1]*13})
        with self.assertRaises(Problem):self.s.act(pid,'measurement_draft',{'kind':'meta_pre','answers':[1]*13})
        self.assertFalse(self.s.gate(self.s.get(pid),'meta_post')['open'])

    def test_json_transport_fences_images_and_fixed_sequence_validation(self):
        import base64
        from unittest.mock import patch, MagicMock
        pid=self.prepared();r=self.s.get(pid)['rounds'][-1]
        r['config']['mode']='real';r['group']='T';r['requests']=[{'turn_index':1}]
        image='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()
        r['messages'] += [{'role':'user' if i%2==0 else 'assistant','content':'合成历史'+str(i)} for i in range(50)]
        r['messages'].append({'role':'user','content':'请看截图','image':image})
        self.s.connection=lambda:{'base_url':'http://127.0.0.1:3005/api/sql-local','source':'edulab-local-bridge','token':'synthetic-token','model':'deepseek-flash'}
        reply={'reply':'老师，这里选的是哪一列？','target':0,'knowledge':{},'reason':'核对'}
        response=MagicMock();response.__enter__.return_value=response
        opener=MagicMock();opener.open.return_value=response
        response.read.return_value=encode({'choices':[{'finish_reason':'stop','message':{'content':'```json\n'+encode(reply)+'\n```'}}]}).encode()
        with patch('server.urllib.request.build_opener',return_value=opener):
            result=self.s.infer(r)
            self.assertEqual(result['target'],0)
            payload=json.loads(opener.open.call_args[0][0].data)
            self.assertEqual(payload['response_format'],{'type':'json_object'})
            self.assertEqual(len(payload['messages']),25)
            self.assertGreater(len(r['messages']),50)
            self.assertEqual(payload['messages'][-1]['content'][1]['image_url']['url'],image)
            reply['target']=1
            response.read.return_value=encode({'choices':[{'finish_reason':'stop','message':{'content':encode(reply)}}]}).encode()
            with self.assertRaises(Problem):self.s.infer(r)

    def test_failed_requests_do_not_skip_task_checkpoint_or_consume_success_budget(self):
        pid=self.prepared();p=self.s.get(pid);r=p['rounds'][-1]
        r['config']['max_questions']=1
        r['requests']=[{'id':'old','status':'failed','turn_index':1}]
        r['messages'].append({'role':'user','content':'之前未回复'})
        self.s.save(p)
        self.s.chat(pid,{'text':'从学生表选姓名列','request_id':'after-failure'})
        for _ in range(100):
            if pid not in self.s.active:break
            time.sleep(.01)
        r=self.s.get(pid)['rounds'][-1]
        self.assertEqual(r['requests'][-1]['turn_index'],1)
        self.assertEqual(r['requests'][-1]['status'],'completed')
        for n in range(8):
            self.s.chat(pid,{'text':'继续解释姓名列','request_id':'unlimited-'+str(n)})
            for _ in range(100):
                if pid not in self.s.active:break
                time.sleep(.01)
        self.assertEqual(len(self.s.get(pid)['rounds'][-1]['requests']),10)
        for invalid in ['data:text/html;base64,PHNjcmlwdD4=','https://example.org/image.png','data:image/png;base64,YWJj']:
            with self.assertRaises(Problem):self.s.chat(pid,{'text':'图片','image':invalid,'request_id':'bad-image'})

    def test_image_only_message_and_archive_preserve_image(self):
        import base64
        pid=self.prepared();p=self.s.get(pid);p['rounds'][-1]['config']['mode']='real';self.s.save(p)
        self.s.connection=lambda:{'token':'synthetic'}
        self.s.model_call=lambda r,c:{'reply':'老师，我看到了截图。','target':0,'knowledge':{},'reason':'示例','source':'synthetic'}
        image='data:image/png;base64,'+base64.b64encode(b'\x89PNG\r\n\x1a\nsynthetic').decode()
        self.s.chat(pid,{'text':'','image':image,'request_id':'image-only'})
        for _ in range(100):
            if pid not in self.s.active:break
            time.sleep(.01)
        archive=self.s.archive(pid)
        message=next(m for m in archive['study']['rounds'][0]['messages'] if m.get('image'))
        self.assertEqual(message['content'],'请看这张截图。');self.assertEqual(message['image'],image)
        self.assertEqual(next(m['image'] for m in archive['conversations'][0]['messages'] if m.get('image')),image)
        key=self.s.queue(pid)
        with self.s.db() as db:backup=json.loads(db.execute('select payload from backups where id=?',(key,)).fetchone()[0])
        self.assertIn(image,encode(backup))
        transport=self.s.backup_payload({'payload':encode(backup),'id':key,'sha256':'synthetic'})
        self.assertEqual(set(transport['archive']),{'exported_at'})
        self.assertEqual(transport['canonical'].count(image),2)
        self.assertEqual(encode(transport).count(image),2)

    def test_pending_reply_does_not_delay_practice_or_attach_to_a_later_round(self):
        pid=self.prepared();started=threading.Event();release=threading.Event()
        p=self.s.get(pid);p['rounds'][0]['config']['mode']='real';self.s.save(p)
        self.s.connection=lambda:{'token':'synthetic'}
        def delayed(r,c):
            started.set();release.wait(3)
            return {'reply':'延迟的模拟回复','target':0,'knowledge':{},'source':'synthetic'}
        self.s.model_call=delayed
        self.s.chat(pid,{'text':'从学生表选姓名列','request_id':'pending'})
        self.assertTrue(started.wait(2));self.clock[0]+=901;self.open('practice0','auto')
        self.assertTrue(self.s.state(pid)['gates']['practice0']['open'])
        self.s.act(pid,'start_practice',{})
        p=self.s.get(pid);start=p['rounds'][0]['practice_start']
        self.assertTrue(any(e['type']=='practice_without_completed_ai_reply' for e in p['events']))
        p['rounds'].append({'id':'later-round','index':1,'requests':[],'messages':[]});self.s.save(p)
        release.set()
        for _ in range(100):
            if pid not in self.s.active:break
            time.sleep(.01)
        p=self.s.get(pid)
        self.assertEqual(p['rounds'][0]['requests'][-1]['status'],'completed')
        self.assertEqual(p['rounds'][0]['practice_start'],start)
        self.assertEqual(p['rounds'][1]['messages'],[])

    def test_name_confirmation_and_same_name_restores_record(self):
        with self.assertRaises(Problem):self.s.enter({'class_code':CLASSES[0],'name':'测试'})
        p=self.student();s=self.student()
        self.assertEqual(p['id'],s['id']);self.assertNotEqual(p['session_token'],s['session_token'])
        self.assertNotEqual(self.student(cls=CLASSES[1])['id'],p['id'])
        self.assertNotIn('code',p);self.assertNotIn('group',p);self.assertNotIn('session_hash',p)
    def test_class_schedule_cannot_be_bypassed_by_client(self):
        p=self.student();self.open('pretest','scheduled',open_at=1010,close_at=1020)
        self.assertFalse(self.s.gate(self.s.get(p['id']),'pretest')['open'])
        with self.assertRaises(Problem):self.s.act(p['id'],'pretest',{'answers':['A']*20})
        self.clock[0]=1015;self.assertTrue(self.s.gate(self.s.get(p['id']),'pretest')['open'])
        other=self.student(cls=CLASSES[1]);self.assertFalse(self.s.gate(self.s.get(other['id']),'pretest')['open'])
        self.clock[0]=1020;self.assertFalse(self.s.gate(self.s.get(p['id']),'pretest')['open'])
    def test_stratified_grouping_and_export(self):
        for i in range(12):
            pid=self.student('测试'+str(i))['id'];p=self.s.get(pid);p['pretest']={'score':(i//2)*15};self.s.save(p)
        self.assertEqual(self.s.assign()['assigned'],12)
        with self.s.db() as db:people=[json.loads(r[0]) for r in db.execute('SELECT data FROM students')]
        pairs={}
        for p in people:pairs.setdefault(p['assignment']['pair'],[]).append(p)
        for pair in pairs.values():self.assertEqual({p['group'] for p in pair},{'L','T'})
        balance=self.s.balance();self.assertEqual(balance[0]['mean'],balance[1]['mean']);self.assertEqual(balance[0]['sd'],balance[1]['sd'])
        export=self.s.groups_export()['csv'];self.assertIn('前测标准差',export);self.assertIn('测试0',export)
        self.assertEqual(self.s.assign()['assigned'],0)
    def test_teaching_cannot_be_skipped_and_prompt_snapshot_is_immutable(self):
        pid=self.prepared();old=self.s.get(pid)['rounds'][0]['config']
        with self.assertRaises(Problem):self.s.act(pid,'start_practice',{})
        self.clock[0]+=901
        with self.assertRaises(Problem):self.s.act(pid,'start_practice',{})
        c=self.s.config();c['prompts']['common']+='新增调试规则';self.s.configure({'prompts':c['prompts']})
        self.assertEqual(self.s.get(pid)['rounds'][0]['config'],old)
        self.assertGreater(self.s.config()['prompt_version'],old['prompt_version'])
    def test_timeout_freezes_draft(self):
        pid=self.prepared();self.practice(pid);limit=self.s.get(pid)['rounds'][0]['config']['practice_seconds'];self.clock[0]+=limit+1;r=self.s.state(pid)['rounds'][0]
        self.assertEqual(r['phase'],'quiz');self.assertEqual(r['submission']['elapsed_seconds'],limit)
        self.assertEqual(r['submission']['sql'],'SELECT 1;')
        with self.assertRaises(Problem):self.s.act(pid,'draft',{'sql':'change'})
    def test_sql_posttest_teacher_scoring_and_no_answer_leak(self):
        pid=self.prepared(legacy_quiz=True);self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.quiz_questions(self.s.get(pid)['rounds'][-1])],'sql_answers':['SELECT 学生编号,姓名 FROM 学生表;',"SELECT * FROM 学生表 WHERE 姓名 LIKE '张%';"]})
        self.assertIsNone(self.s.get(pid)['rounds'][0]['quiz']['score'])
        self.s.grade({'id':pid,'lesson':0,'scores':[20,19]})
        self.assertEqual(self.s.get(pid)['rounds'][0]['quiz']['score'],99)
        self.assertNotIn('quiz',self.s.public(self.s.get(pid))['rounds'][0])
    def test_quiz_timeout_preserves_partial_sql(self):
        pid=self.prepared(legacy_quiz=True);self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        self.s.act(pid,'quiz_draft',{'answers':['A']*len(self.s.quiz_questions(self.s.get(pid)['rounds'][-1])),'sql_answers':['SELECT 1;','']})
        self.clock[0]+=601;self.s.state(pid);q=self.s.get(pid)['rounds'][0]['quiz']
        self.assertEqual(q['sql_answers'][0],'SELECT 1;');self.assertEqual(q['status'],'timeout')
    def test_debug_does_not_create_student_data(self):
        before=self.s.teacher()['students'];r=self.s.debug({'lesson':0,'text':'从表取姓名列'})
        self.assertEqual(set(r['results']),{'L','T'});self.assertEqual(self.s.teacher()['students'],before)
    def test_restart_and_backups_preserve_no_session_secret(self):
        pid=self.prepared();self.interact(pid);p=self.s.get(pid)
        again=Store(self.tmp.name,clock=lambda:self.clock[0]);self.assertEqual(again.get(pid)['rounds'],p['rounds'])
        a=self.s.archive(pid);self.assertEqual(a['participant']['name'],'测试');self.assertNotIn('session_hash',encode(a))
        key=self.s.queue(pid);self.assertEqual(self.s.queue(pid),key)
        with self.s.db() as db:r=db.execute('SELECT * FROM backups WHERE id=?',(key,)).fetchone()
        a=json.loads(r['payload']);a.pop('exported_at');self.assertEqual(hashlib.sha256(encode(a).encode()).hexdigest(),r['sha256'])
    def test_full_three_rounds_and_questionnaire(self):
        pid=self.prepared()
        for i in range(3):
            if i:self.s.act(pid,'new_round',{});self.s.act(pid,'start_teaching',{})
            self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
            self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.bank['quizzes'][i]]})
        self.open('meta_post');self.s.act(pid,'meta_post',{'answers':[4]*13})
        self.assertTrue(self.s.state(pid)['has_meta_post'])
    def test_measurement_start_is_not_reset_and_export_has_seconds(self):
        import csv,io
        pid=self.student()['id'];self.open('pretest')
        self.s.act(pid,'begin_measurement',{'kind':'pretest'});self.clock[0]+=12
        self.s.act(pid,'begin_measurement',{'kind':'pretest'});self.clock[0]+=8
        self.s.act(pid,'pretest',{'answers':[q['answer'] for q in self.s.bank['pretest']]})
        self.assertEqual(self.s.get(pid)['pretest']['elapsed_seconds'],20)
        rows=list(csv.DictReader(io.StringIO(self.s.timing_export()['csv'])))
        self.assertEqual(rows[0]['用时秒'],'20.0');self.assertEqual(rows[0]['阶段'],'基础前测')

    def test_practice_and_quiz_export_exclude_wait_for_open(self):
        import csv,io
        pid=self.prepared();self.practice(pid);self.clock[0]+=23
        self.s.act(pid,'submit_practice',{});self.clock[0]+=77
        self.s.act(pid,'start_quiz',{});self.clock[0]+=16
        self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.bank['quizzes'][0]]})
        rows=[r for r in csv.DictReader(io.StringIO(self.s.timing_export()['csv'])) if r['内部编号']==pid]
        self.assertEqual(next(r for r in rows if r['阶段']=='独立实操')['用时秒'],'23.0')
        self.assertEqual(next(r for r in rows if r['阶段']=='当课后测')['用时秒'],'16.0')

    def test_cloud_sync_applies_config_assignment_and_grade_without_rewriting_started_prompt(self):
        from unittest.mock import patch,MagicMock
        pid=self.prepared(legacy_quiz=True);self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.quiz_questions(self.s.get(pid)['rounds'][-1])],'sql_answers':['one','two']})
        p=self.s.get(pid);snapshot=p['rounds'][0]['config'];cfg=self.s.config();cfg['prompts']['common']='云端新版本';cfg['prompt_version']+=1
        payload={'config':cfg,'revision':7,'server_now':self.clock[0]+20,'assignments':[{'class_code':p['class_code'],'participant_name':p['name'],'group_code':p['group'],'batch_id':'cloud-batch','pair_no':1,'method':'cloud-fixed','pretest_score':'100'}],'grades':[{'participant_id':pid,'lesson':0,'scores':[20,19],'updated_at':'2026-11-08T00:00:00Z'}]}
        self.s.connection=lambda:{'source':'edulab-local-bridge','base_url':'http://127.0.0.1:3005/api/sql-local','token':'local-capability'}
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps(payload).encode()
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value=response;self.s.sync_cloud_control()
        updated=self.s.get(pid);self.assertEqual(updated['rounds'][0]['config'],snapshot)
        self.assertEqual(updated['rounds'][0]['quiz']['score'],99);self.assertEqual(updated['assignment']['source'],'edulab-cloud')
        self.assertEqual(self.s.config()['cloud_revision'],7);self.assertEqual(self.s.remote_time_offset,20)
        self.assertNotIn('教师管理',(Path(__file__).resolve().parents[1]/'web/app.js').read_text());self.assertNotIn('teacher-content',(Path(__file__).resolve().parents[1]/'web/index.html').read_text())

    def test_automatic_practice_unlocks_after_teaching_and_a_submitted_explanation(self):
        pid=self.prepared();self.open('practice0','auto')
        self.assertFalse(self.s.state(pid)['gates']['practice0']['open'])
        self.clock[0]+=901;self.assertFalse(self.s.state(pid)['gates']['practice0']['open'])
        p=self.s.get(pid);p['rounds'][0]['requests'].append({'id':'failed-explanation','status':'failed'});p['rounds'][0]['messages'].append({'role':'user','content':'解释已提交','request_id':'failed-explanation'});self.s.save(p)
        self.assertTrue(self.s.state(pid)['gates']['practice0']['open'])
        self.s.act(pid,'start_practice',{});self.open('practice0','closed')
        self.s.act(pid,'draft',{'sql':'SELECT 1;','result':'1'});self.s.act(pid,'submit_practice',{})
        self.assertEqual(self.s.get(pid)['rounds'][0]['submission']['sql'],'SELECT 1;')
        self.assertEqual(self.s.get(pid)['rounds'][0]['requests'][0]['status'],'failed')
        self.assertEqual(sum(e['type']=='practice_without_completed_ai_reply' for e in self.s.get(pid)['events']),1)

    def test_backup_cannot_be_disabled(self):
        with self.assertRaises(Problem):self.s.configure({'backup_enabled':False})
        cfg=self.s.config();cfg['backup_enabled']=False;self.s.put_config(cfg)
        self.assertTrue(self.s.config()['backup_enabled'])

    def test_both_groups_have_same_student_greeting_and_missing_group_is_explicit(self):
        for group in ('L','T'):
            pid=self.student('greeting'+group)['id'];p=self.s.get(pid)
            p.update(pretest={'score':100},meta_pre={'answers':[3]*13},group=None);self.s.save(p);self.open('ai0')
            p['course_order']=[0,1,2];self.s.save(p)
            with self.assertRaisesRegex(Problem,'分组'):self.s.act(pid,'new_round',{})
            p['group']=group;self.s.save(p);self.s.act(pid,'new_round',{});self.s.act(pid,'start_teaching',{})
            self.assertEqual(self.s.get(pid)['rounds'][0]['messages'][0]['content'],'老师好，今天我们要学什么？')

    def test_http_auth_no_keys_and_teacher_export_only(self):
        p=self.student();self.open('pretest')
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.store=self.s
        threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
        headers={'X-Local-Key':self.s.token,'X-Participant':p['id'],'X-Participant-Session':p['session_token']}
        try:
            with self.assertRaises(urllib.error.HTTPError):local_open(base+'/api/health')
            bank=json.load(local_open(urllib.request.Request(base+'/api/questions?kind=pretest',headers=headers)))
            self.assertTrue(all('answer' not in q for q in bank))
            for path in ('/api/export','/api/teacher/groups','/api/teacher/timings'):
                with self.assertRaises(urllib.error.HTTPError):local_open(urllib.request.Request(base+path,headers=headers))
            with self.assertRaises(urllib.error.HTTPError):local_open(urllib.request.Request(base+'/api/state',headers={**headers,'Origin':'http://evil.test'}))
        finally:server.shutdown();server.server_close()

    def test_new_quiz_has_ten_single_choices_and_cannot_change_assignment(self):
        pid=self.prepared();p=self.s.get(pid);before=(p['pretest'],p['group'],p.get('assignment'),p['rounds'][0]['config'])
        self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        r=self.s.get(pid)['rounds'][-1];questions=self.s.quiz_questions(r)
        self.assertEqual(len(questions),10);self.assertEqual(self.s.quiz_sql_items(r),[])
        with self.assertRaises(Problem):self.s.act(pid,'quiz',{'answers':['A']*9})
        self.s.act(pid,'quiz',{'answers':['A']*10})
        p=self.s.get(pid);q=p['rounds'][0]['quiz']
        self.assertEqual(q['score'],sum(x['answer']=='A' for x in questions)*10)
        self.assertEqual(q['mcq_score'],q['score']);self.assertEqual(q['max_score'],100)
        self.assertEqual(q['grading'],'automatic');self.assertTrue(q['assessment_only'])
        self.assertEqual((p['pretest'],p['group'],p.get('assignment'),p['rounds'][0]['config']),before)
        public=self.s.public(p);self.assertNotIn('quiz_spec',public['rounds'][0]);self.assertNotIn('quiz',public['rounds'][0])
        self.assertEqual(q['items'],questions)
        with self.assertRaises(Problem):self.s.grade({'id':pid,'lesson':0,'scores':[20,20]})
        with self.assertRaises(Problem):self.s.act(pid,'quiz',{'answers':['B']*10})
        again=Store(self.tmp.name,clock=lambda:self.clock[0]);self.assertEqual(again.get(pid)['rounds'][0]['quiz'],q)

    def test_choice_timeout_saves_partial_answers_with_frozen_bank(self):
        pid=self.prepared();self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        r=self.s.get(pid)['rounds'][-1];questions=self.s.quiz_questions(r)
        answers=[questions[0]['answer']]+['']*9
        self.s.act(pid,'quiz_draft',{'answers':answers})
        # Later edits to the current bank must not alter a started assessment.
        self.s.bank['quizzes'][0][0]['answer']='Z'
        self.clock[0]+=601;self.s.state(pid)
        q=self.s.get(pid)['rounds'][-1]['quiz']
        self.assertEqual(q['score'],10);self.assertEqual(q['status'],'timeout')
        self.assertEqual(q['answers'],answers);self.assertEqual(q['elapsed_seconds'],600)
        self.assertEqual(q['items'],questions)

    def test_each_lesson_bank_is_unique_complete_and_within_its_topic(self):
        bank=self.s.bank['quizzes'];self.assertEqual([len(x) for x in bank],[10]*4)
        ids=[q['id'] for items in bank for q in items];self.assertEqual(len(set(ids)),40)
        for items in bank:
            for q in items:
                self.assertEqual(len(q['options']),4);self.assertEqual(len(set(q['options'])),4)
                self.assertIn(q['answer'],'ABCD')
        first=' '.join(q['text']+' '.join(q['options']) for q in bank[3])
        self.assertNotIn('ANY',first);self.assertNotIn('AVG(',first);self.assertNotIn('CASE',first)
        last=' '.join(q['text'] for q in bank[2]);self.assertIn('ANY',last);self.assertIn('ALL',last)


    def test_zero_choice_score_keeps_group_and_allows_original_next_course_flow(self):
        from unittest.mock import patch,MagicMock
        pid=self.prepared();self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        p=self.s.get(pid);before_group=p['group'];before_pretest=p['pretest']
        questions=self.s.quiz_questions(p['rounds'][-1])
        wrong=['B' if q['answer']=='A' else 'A' for q in questions]
        self.s.act(pid,'quiz',{'answers':wrong})
        p=self.s.get(pid);self.assertEqual(p['rounds'][-1]['quiz']['score'],0)
        payload={'config':self.s.config(),'revision':8,'assignments':[], 'grades':[{'participant_id':pid,'lesson':0,'scores':[20,20],'updated_at':'2026-11-08T00:00:00Z'}]}
        self.s.connection=lambda:{'source':'edulab-local-bridge','base_url':'http://127.0.0.1:3005/api/sql-local','token':'local-capability'}
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps(payload).encode()
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value=response;self.s.sync_cloud_control()
        p=self.s.get(pid);self.assertEqual(p['rounds'][-1]['quiz']['score'],0)
        self.assertEqual(p['group'],before_group);self.assertEqual(p['pretest'],before_pretest)
        self.s.act(pid,'new_round',{})
        self.assertEqual(self.s.get(pid)['rounds'][-1]['index'],1)


    def test_http_new_posttest_returns_ten_questions_and_never_exposes_answer_keys(self):
        p=self.student('接口验证');pid=p['id'];self.open('pretest');self.open('meta_pre');self.open('ai3');self.open('posttest3')
        self.s.act(pid,'pretest',{'answers':['A']*20});self.s.act(pid,'meta_pre',{'answers':[3]*13})
        self.s.act(pid,'new_round',{})
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.store=self.s
        threading.Thread(target=server.serve_forever,daemon=True).start();base=f'http://127.0.0.1:{server.server_port}'
        headers={'X-Local-Key':self.s.token,'X-Participant':pid,'X-Participant-Session':p['session_token']}
        try:
            with self.assertRaises(urllib.error.HTTPError):local_open(urllib.request.Request(base+'/api/questions?kind=posttest',headers=headers))
            record=self.s.get(pid);record['rounds'][-1].update(phase='quiz',quiz_start=self.clock[0],quiz_deadline=self.clock[0]+600);self.s.save(record)
            bank=json.load(local_open(urllib.request.Request(base+'/api/questions?kind=posttest',headers=headers)))
            self.assertEqual(len(bank),10);self.assertTrue(all('answer' not in q and q.get('kind')!='sql' for q in bank))
            state=json.load(local_open(urllib.request.Request(base+'/api/state',headers=headers)))
            self.assertNotIn('quiz_spec',state['rounds'][0]);self.assertEqual(state['rounds'][0]['quiz_format'],'single_choice')
        finally:server.shutdown();server.server_close()



class FourLessonTests(unittest.TestCase):
    setUp=StudyTests.setUp
    tearDown=StudyTests.tearDown
    student=StudyTests.student
    open=StudyTests.open
    interact=StudyTests.interact
    # This class only adds the additive preparation lifecycle regression.
    def test_existing_unstarted_identity_adopts_four_course_order(self):
        pid=self.student('升级前已登记')['id']
        p=self.s.get(pid);p.pop('course_order');p['pretest']={'score':50};p['meta_pre']={'answers':[3]*13};self.s.save(p)
        self.open('ai3')
        self.s.act(pid,'new_round',{})
        self.assertEqual(self.s.get(pid)['course_order'],[3,0,1,2])
        self.assertEqual(self.s.state(pid)['unavailable_lessons'],[])
        self.assertEqual(self.s.get(pid)['rounds'][0]['index'],3)

    def test_preparation_runs_before_assignment_then_three_formal_rounds(self):
        pid=self.student('四课学生')['id']
        for key in ('pretest','meta_pre','meta_post'):
            self.open(key)
        for i in range(4):
            for stage in ('ai','practice','posttest'):
                self.open(stage+str(i))
        with self.assertRaises(Problem):
            self.s.act(pid,'new_round',{})
        self.s.act(pid,'pretest',{'answers':[q['answer'] for q in self.s.bank['pretest']]})
        with self.assertRaises(Problem):
            self.s.act(pid,'new_round',{})
        self.s.act(pid,'meta_pre',{'answers':[3]*13})
        self.assertIsNone(self.s.get(pid)['group'])
        for i in [3,0,1,2]:
            self.s.act(pid,'new_round',{})
            self.s.act(pid,'start_teaching',{})
            p=self.s.get(pid);r=p['rounds'][-1]
            self.assertEqual(r['index'],i)
            self.assertEqual(r['group'],'P' if i==3 else 'L')
            self.assertEqual(r['analysis_phase'],'preparation' if i==3 else 'formal')
            self.interact(pid)
            self.clock[0]=r['teaching_deadline']+1
            self.s.act(pid,'start_practice',{})
            self.s.act(pid,'draft',{'sql':'SELECT 1;','result':'1'})
            self.s.act(pid,'submit_practice',{})
            self.s.act(pid,'start_quiz',{})
            self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.bank['quizzes'][i]]})
            if i==3:
                self.assertFalse(self.s.gate(self.s.get(pid),'meta_post')['open'])
                with self.assertRaisesRegex(Problem,'分组'):
                    self.s.act(pid,'new_round',{})
                # Assignment after preparation never changes its frozen common policy.
                p=self.s.get(pid);p['group']='L';self.s.save(p)
                with self.assertRaises(Problem):self.s.grade({'id':pid,'lesson':3,'scores':[19,20]})
                self.assertEqual(self.s.get(pid)['rounds'][0]['quiz']['score'],100)
        public=self.s.state(pid)
        self.assertEqual(public['course_order'],[3,0,1,2])
        self.assertEqual(len(public['tasks']),4)
        self.assertNotIn('analysis_phase',encode(public))
        self.assertNotIn('formal_round',encode(public))
        self.s.act(pid,'meta_post',{'answers':[3]*13})
        self.assertTrue(self.s.state(pid)['has_meta_post'])
        exported=self.s.archive(pid)
        self.assertEqual([r['index'] for r in exported['study']['rounds']],[3,0,1,2])
        self.assertEqual(exported['study']['rounds'][0]['group'],'P')
        timing=self.s.timing_export()['csv']
        self.assertIn('准备阶段',timing)
        self.assertIn('正式干预',timing)



if __name__=='__main__':unittest.main()
