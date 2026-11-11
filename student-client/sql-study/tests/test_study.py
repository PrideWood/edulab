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
from server import Store as CurrentStore,Problem,Handler,encode
# Regression harness for immutable pre-research snapshots; new protocol is covered separately.
class Store(CurrentStore.__bases__[0].__bases__[0]):
    def __init__(self,*args,**kwargs):
        super().__init__(*args,**kwargs)
        from course_layout import PREPARATION_POLICY
        cfg=self.config();cfg.pop('research',None);cfg.pop('research_questions',None);cfg.pop('access_policy',None);cfg.pop('current_lessons',None);cfg.pop('test_cleanup_epoch',None);cfg['prompts']['preparation']=PREPARATION_POLICY;self.put_config(cfg)
    def put_config(self,cfg):
        cfg=dict(cfg)
        for key in ('research','research_questions','access_policy','current_lessons','test_cleanup_epoch'):cfg.pop(key,None)
        super().put_config(cfg)
from study_control import CLASSES

class StudyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.clock=[1000.0]
        self.s=Store(self.tmp.name,clock=lambda:self.clock[0])
    def tearDown(self):self.s.stop.set();self.tmp.cleanup()
    def test_cloud_classes_control_login_without_rewriting_history(self):
        self.assertEqual(self.s.active_classes(), ['2531','2532'])
        old=self.student('保留记录')
        cfg=self.s.config()
        cfg['classes'].append({'code':'2533','label':'新增班级','planned_size':None,'enabled':True})
        cfg['schedules']['2533']=json.loads(json.dumps(cfg['schedules']['2531']))
        self.s.put_config(cfg)
        new=self.student('新同学', '2533')
        self.assertEqual(new['class_code'], '2533')
        self.assertIn({'code':'2533','label':'新增班级'}, self.s.class_options()['classes'])
        cfg['classes'][0]['enabled']=False
        self.s.put_config(cfg)
        with self.assertRaises(Problem):self.student('新同学', '2531')
        self.assertEqual(self.s.get(old['id'])['name'], '保留记录')
        self.assertIn('保留记录', self.s.groups_export()['csv'])
        self.assertFalse(self.s.gate(self.s.get(old['id']), 'pretest')['open'])

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
        legacy=self.s.get(pid);legacy['course_order']=[0,1,2];legacy['scheme_version']='legacy-fixture/1';self.s.save(legacy)
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
            self.assertEqual(len(payload['messages']),26)
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

    def test_chat_continues_after_suggested_time_and_stage_switch(self):
        pid=self.prepared();self.clock[0]+=1001;self.interact(pid)
        self.s.act(pid,'start_practice',{});r=self.s.get(pid)['rounds'][0]
        self.assertEqual(r['teaching_end']-r['teaching_start'],1001)
        self.clock[0]+=1;self.interact(pid)
        self.assertEqual(self.s.get(pid)['rounds'][0]['teaching_end']-r['teaching_start'],1002)

    def test_model_redirect_only_preserves_body_and_auth_for_same_https_origin(self):
        from server import ModelRedirect
        req=urllib.request.Request('https://api.deepseek.com/chat/completions',data=b'synthetic',headers={'Authorization':'Bearer synthetic-key','Content-Type':'application/json'})
        handler=ModelRedirect()
        redirected=handler.redirect_request(req,None,307,'',{},'https://api.deepseek.com/v1/chat/completions')
        self.assertEqual(redirected.get_method(),'POST');self.assertEqual(redirected.data,b'synthetic')
        self.assertEqual(redirected.get_header('Authorization'),'Bearer synthetic-key')
        for target in ['https://other.example/chat','http://api.deepseek.com/chat','https://api.deepseek.com:8443/chat','https://user@api.deepseek.com/chat']:
            self.assertIsNone(handler.redirect_request(req,None,307,'',{},target))
        self.assertIsNone(handler.redirect_request(req,None,302,'',{},'https://api.deepseek.com/chat'))

    def test_direct_provider_stream_preserves_answer_and_excludes_reasoning(self):
        import io
        from server import read_provider_response
        frames=[{'choices':[{'delta':{'reasoning_content':'hidden'}}]}, {'choices':[{'delta':{'content':'{"reply":"老师好"'},'finish_reason':None}]}, {'choices':[{'delta':{'content':'}'},'finish_reason':'stop'}]}]
        response=io.BytesIO(('\n\n'.join('data: '+encode(v) for v in frames)+'\n\ndata: [DONE]\n').encode());response.headers={'Content-Type':'text/event-stream'}
        out=read_provider_response(response,True)
        self.assertEqual(out['choices'][0]['finish_reason'],'stop')
        self.assertEqual(json.loads(out['choices'][0]['message']['content'])['reply'],'老师好')
        self.assertNotIn('hidden',encode(out))

    def test_windows_empty_json_response_recovers_without_relaxing_schema(self):
        import io
        from unittest.mock import patch,MagicMock
        pid=self.prepared();r=self.s.get(pid)['rounds'][-1];r['config']['mode']='real';r['requests']=[{'turn_index':1}]
        self.s.connection=lambda:{'source':'windows-direct','base_url':'https://api.deepseek.com','model':'deepseek-flash','token':'synthetic-token'}
        def response(content):
            value=io.BytesIO(encode({'choices':[{'finish_reason':'stop','message':{'content':content}}]}).encode());value.headers={'Content-Type':'application/json'};return value
        opener=MagicMock();opener.open.side_effect=[response(' '),response(encode({'reply':'老师，我还想确认来源表。','target':0,'knowledge':{},'reason':'核对'}))]
        with patch('server.urllib.request.build_opener',return_value=opener),patch('server.time.sleep'):
            result=self.s.infer(r)
        self.assertEqual(result['transport']['attempts'],2)
        first,second=[json.loads(call.args[0].data) for call in opener.open.call_args_list]
        self.assertEqual(first['response_format']['type'],'json_object');self.assertNotIn('response_format',second)
        self.assertEqual(first['messages'],second['messages'])

    def test_windows_natural_reply_preserves_unknown_assessment_and_fixed_policy(self):
        import io
        from unittest.mock import patch,MagicMock
        pid=self.prepared();r=self.s.get(pid)['rounds'][-1];r['config']['mode']='real';r['requests']=[{'turn_index':2}]
        self.s.connection=lambda:{'source':'windows-direct','base_url':'https://api.deepseek.com','model':'deepseek-flash','token':'synthetic-token'}
        for group,expected in [('L',None),('T',1)]:
            r['group']=group;raw=io.BytesIO(encode({'choices':[{'finish_reason':'stop','message':{'content':'老师，这一列代表什么？'}}]}).encode());raw.headers={'Content-Type':'application/json'}
            opener=MagicMock();opener.open.return_value=raw
            with patch('server.urllib.request.build_opener',return_value=opener):result=self.s.infer(r)
            self.assertEqual(result['reply'],'老师，这一列代表什么？');self.assertEqual(result['target'],expected)
            self.assertEqual(result['knowledge'],r['knowledge']);self.assertFalse(result['transport']['assessment_state_updated'])
            self.assertEqual(result['source'],'model-natural-no-state')

    def test_windows_gbk_default_can_load_utf8_questions_and_restore_chinese_names(self):
        from unittest.mock import patch
        original=Path.read_text
        def gbk_default(path,*args,**kwargs):
            if not args and kwargs.get('encoding') is None:kwargs['encoding']='gbk'
            return original(path,*args,**kwargs)
        with tempfile.TemporaryDirectory() as directory,patch.object(Path,'read_text',gbk_default):
            store=Store(directory)
            self.assertEqual(store.bank,self.s.bank)
            first=store.enter({'class_code':CLASSES[0],'name':'中文姓名测试','confirmed':True})
            restored=Store(directory)
            again=restored.enter({'class_code':CLASSES[0],'name':'中文姓名测试','confirmed':True})
            self.assertEqual(again['id'],first['id']);self.assertEqual(again['name'],'中文姓名测试')
            store.stop.set();restored.stop.set()

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
    def test_practice_can_skip_teaching_and_prompt_snapshot_is_immutable(self):
        pid=self.prepared();old=self.s.get(pid)['rounds'][0]['config']
        self.s.act(pid,'start_practice',{})
        self.clock[0]+=901
        with self.assertRaises(Problem):self.s.act(pid,'start_practice',{})
        c=self.s.config();c['prompts']['common']+='新增调试规则';self.s.configure({'prompts':c['prompts']})
        self.assertEqual(self.s.get(pid)['rounds'][0]['config'],old)
        self.assertGreater(self.s.config()['prompt_version'],old['prompt_version'])
    def test_suggested_practice_time_never_freezes_and_actual_time_is_preserved(self):
        pid=self.prepared();self.practice(pid);limit=self.s.get(pid)['rounds'][0]['config']['practice_seconds'];self.clock[0]+=limit+1
        r=self.s.state(pid)['rounds'][0];self.assertEqual(r['phase'],'practice');self.assertIsNone(r['submission'])
        self.s.act(pid,'draft',{'sql':'SELECT 2;','result':'2'});self.clock[0]+=33
        self.s.act(pid,'submit_practice',{});r=self.s.get(pid)['rounds'][0]
        self.assertEqual(r['submission']['elapsed_seconds'],limit+34)
        self.assertEqual(r['submission']['sql'],'SELECT 2;');self.assertEqual(r['submission']['status'],'submitted')
    def test_sql_posttest_teacher_scoring_and_no_answer_leak(self):
        pid=self.prepared(legacy_quiz=True);self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.quiz_questions(self.s.get(pid)['rounds'][-1])],'sql_answers':['SELECT 学生编号,姓名 FROM 学生表;',"SELECT * FROM 学生表 WHERE 姓名 LIKE '张%';"]})
        self.assertIsNone(self.s.get(pid)['rounds'][0]['quiz']['score'])
        self.s.grade({'id':pid,'lesson':0,'scores':[20,19]})
        self.assertEqual(self.s.get(pid)['rounds'][0]['quiz']['score'],99)
        self.assertNotIn('quiz',self.s.public(self.s.get(pid))['rounds'][0])
    def test_suggested_quiz_time_preserves_editable_partial_sql(self):
        pid=self.prepared(legacy_quiz=True);self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        self.s.act(pid,'quiz_draft',{'answers':['A']*len(self.s.quiz_questions(self.s.get(pid)['rounds'][-1])),'sql_answers':['SELECT 1;','']})
        self.clock[0]+=601;r=self.s.state(pid)['rounds'][0]
        self.assertEqual(r['phase'],'quiz');self.assertEqual(r['draft_quiz']['sql_answers'][0],'SELECT 1;')
        self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.quiz_questions(self.s.get(pid)['rounds'][-1])],'sql_answers':['SELECT 2;','SELECT 3;']})
        self.assertEqual(self.s.get(pid)['rounds'][0]['quiz']['elapsed_seconds'],601)
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
            p['course_order']=[0,1,2];p['scheme_version']='legacy-fixture/1';self.s.save(p)
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
            with self.assertRaises(urllib.error.HTTPError):local_open(base+'/api/classes')
            options=json.load(local_open(urllib.request.Request(base+'/api/classes',headers={'X-Local-Key':self.s.token})))
            self.assertEqual(options, {'classes':[{'code':'2531','label':'2531'},{'code':'2532','label':'2532'}]})
            self.assertEqual(set(options['classes'][0]), {'code','label'})
            bank=json.load(local_open(urllib.request.Request(base+'/api/questions?kind=pretest',headers=headers)))
            self.assertTrue(all('answer' not in q for q in bank))
            for path in ('/api/export','/api/teacher/groups','/api/teacher/timings'):
                with self.assertRaises(urllib.error.HTTPError):local_open(urllib.request.Request(base+path,headers=headers))
            with self.assertRaises(urllib.error.HTTPError):local_open(urllib.request.Request(base+'/api/state',headers={**headers,'Origin':'http://evil.test'}))
        finally:server.shutdown();server.server_close()

    def test_same_origin_browser_policy_and_login_keep_cross_site_guard(self):
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.store=self.s
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        base='http://127.0.0.1:'+str(server.server_port)
        try:
            with local_open(base+'/') as response:self.assertEqual(response.headers['Referrer-Policy'],'same-origin')
            payload=encode({'class_code':'2531','name':'来源回归','confirmed':True}).encode()
            headers={'X-Local-Key':self.s.token,'Content-Type':'application/json','Origin':base}
            with local_open(urllib.request.Request(base+'/api/enter',data=payload,headers=headers)) as response:
                participant=json.load(response);self.assertTrue(participant['id']);self.assertTrue(participant['session_token'])
            for origin in ('null','http://evil.test',base+'0','https://'+base[7:]):
                with self.assertRaises(urllib.error.HTTPError) as caught:local_open(urllib.request.Request(base+'/api/enter',data=payload,headers={**headers,'Origin':origin}))
                self.assertEqual(caught.exception.code,403)
            with self.assertRaises(urllib.error.HTTPError) as caught:local_open(urllib.request.Request(base+'/api/enter',data=payload,headers={**headers,'X-Local-Key':'wrong'}))
            self.assertEqual(caught.exception.code,403)
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

    def test_suggested_choice_time_keeps_drafts_and_frozen_bank_until_manual_submit(self):
        pid=self.prepared();self.practice(pid);self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        questions=self.s.quiz_questions(self.s.get(pid)['rounds'][-1]);answers=[questions[0]['answer']]+['']*9
        self.s.act(pid,'quiz_draft',{'answers':answers});self.s.bank['quizzes'][0][0]['answer']='Z'
        self.clock[0]+=601;r=self.s.state(pid)['rounds'][0]
        self.assertEqual(r['phase'],'quiz');self.assertEqual(r['draft_quiz']['answers'],answers)
        self.s.act(pid,'quiz',{'answers':[q['answer'] for q in questions]});q=self.s.get(pid)['rounds'][0]['quiz']
        self.assertEqual(q['status'],'submitted');self.assertEqual(q['elapsed_seconds'],601);self.assertEqual(q['score'],100);self.assertEqual(q['items'],questions)

    def test_each_lesson_bank_is_unique_complete_and_within_its_topic(self):
        bank=self.s.bank['quizzes'];self.assertEqual([len(x) for x in bank],[10]*4+[4])
        ids=[q['id'] for items in bank for q in items];self.assertEqual(len(set(ids)),44)
        for items in bank:
            for q in items:
                self.assertEqual(len(q['options']),4);self.assertEqual(len(set(q['options'])),4)
                self.assertIn(q['answer'],'ABCD')
        first=' '.join(q['text']+' '.join(q['options']) for q in bank[4])
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
        grouped=self.s.get(pid);grouped['group']='L';grouped['scheme_version']='legacy-fixture/1';grouped['course_order']=[3,0,1,2];self.s.save(grouped)
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


    def test_cloud_test_switch_restores_first_lesson_and_preserves_old_round(self):
        from unittest.mock import patch,MagicMock
        pid=self.prepared();self.interact(pid);p=self.s.get(pid)
        previous=json.loads(encode(p['rounds']));measurements=(p['pretest'],p['meta_pre'],p['group'],p.get('assignment'))
        # Simulate a pre-four-course archive with its second displayed class active.
        p.pop('course_order');self.s.save(p)
        command={'id':'switch-one','scheme_version':'business-workorders/1','research_version':'sql-lt/1.1','device_id':self.s.setting('device'),'participant_id':pid,'lesson':3,'test_identity_verified':True}
        cfg=self.s.config()
        for rule in cfg['schedules'][CLASSES[0]].values():rule['mode']='closed'
        payload={'config':cfg,'revision':12,'assignments':[],'grades':[],'test_lesson_commands':[command]}
        self.s.connection=lambda:{'source':'edulab-local-bridge','base_url':'http://127.0.0.1:3005/api/sql-local','token':'test-bridge'}
        response=MagicMock();response.__enter__.return_value.read.return_value=json.dumps(payload).encode()
        with patch('urllib.request.build_opener') as opener:
            opener.return_value.open.return_value=response;self.s.sync_cloud_control()
            p=self.s.get(pid)
            self.assertEqual(p['rounds'],[]);self.assertEqual(p['course_order'],[3,4,0,1,2])
            self.assertEqual(p['test_lesson_history'][0]['rounds'],previous)
            self.assertEqual((p['pretest'],p['meta_pre'],p['group'],p.get('assignment')),measurements)
            state=self.s.state(pid);self.assertEqual(state['next_lesson'],3);self.assertEqual(state['unavailable_lessons'],[])
            self.assertTrue(state['gates']['ai3']['open']);self.assertFalse(state['gates']['ai0']['open'])
            self.assertNotIn('test_lesson_history',state)
            self.s.act(pid,'new_round',{});self.s.act(pid,'start_teaching',{})
            self.assertEqual(self.s.get(pid)['rounds'][0]['group'],measurements[2])
            self.s.sync_cloud_control()  # Repeated polling must not restart the selected lesson.
            self.assertEqual(len(self.s.get(pid)['test_lesson_history']),1)
            self.assertEqual(self.s.get(pid)['rounds'][0]['phase'],'teaching')
            with self.assertRaises(Problem):self.s.act(pid,'draft',{'round_id':previous[0]['id'],'sql':'stale'})
            with self.assertRaises(Problem):self.s.chat(pid,{'round_id':previous[0]['id'],'text':'stale'})
        again=Store(self.tmp.name,clock=lambda:self.clock[0]);self.assertEqual(again.get(pid)['test_lesson_history'][0]['rounds'],previous)

    def test_test_switch_is_device_scoped_verified_and_defers_running_model(self):
        pid=self.prepared();p=self.s.get(pid)
        cmd={'id':'switch','scheme_version':'business-workorders/1','research_version':'sql-lt/1.1','device_id':self.s.setting('device'),'participant_id':pid,'lesson':3,'test_identity_verified':True}
        for bad in [{**cmd,'scheme_version':'old/1'},{**cmd,'device_id':'other-device'},{**cmd,'participant_id':'other-student'},{**cmd,'test_identity_verified':False},{**cmd,'lesson':True}]:
            self.assertFalse(self.s.apply_test_lesson_command(p,bad))
        self.s.active.add(pid);self.assertFalse(self.s.apply_test_lesson_command(p,cmd));self.s.active.remove(pid)
        self.assertTrue(self.s.apply_test_lesson_command(p,cmd));self.assertFalse(self.s.apply_test_lesson_command(p,cmd))
        self.assertEqual(len(p['test_lesson_history']),1)


    def test_model_bridge_failure_retains_safe_diagnostics_and_separates_billing_from_empty(self):
        import io
        from unittest.mock import patch,MagicMock
        pid=self.prepared();r=self.s.get(pid)['rounds'][-1];r['config']['mode']='real';r['requests']=[{'turn_index':1}]
        self.s.connection=lambda:{'base_url':'http://127.0.0.1:3005/api/sql-local','source':'edulab-local-bridge','token':'synthetic-token','model':'deepseek-flash'}
        for status,code,expected in [(502,'EMPTY_ANSWER','空内容'),(402,'DEEPSEEK_HTTP_402','余额不足'),(429,'DEEPSEEK_HTTP_429','并发限制')]:
            error=urllib.error.HTTPError('http://127.0.0.1',status,'synthetic',{},io.BytesIO(encode({'code':code,'error':'SECRET_MUST_NOT_LEAK','attempts':3,'elapsed_ms':900}).encode()))
            with patch('server.urllib.request.build_opener') as opener:
                opener.return_value.open.side_effect=error
                with self.assertRaises(Problem) as caught:self.s.infer(r)
                self.assertIn(expected,str(caught.exception));self.assertNotIn('SECRET_MUST_NOT_LEAK',str(caught.exception))
                self.assertEqual(caught.exception.code,code);self.assertEqual(caught.exception.diagnostics['attempts'],3)
                self.assertEqual(opener.return_value.open.call_args.kwargs['timeout'],110)



class BusinessWorkorderTests(unittest.TestCase):
    setUp=StudyTests.setUp
    tearDown=StudyTests.tearDown
    student=StudyTests.student
    open=StudyTests.open
    interact=StudyTests.interact
    def baseline(self):
        pid=self.student('新方案验证')['id']
        for key in ('pretest','meta_pre','meta_post'):self.open(key)
        for i in range(5):
            for stage in ('ai','practice','posttest'):self.open(stage+str(i))
        self.s.act(pid,'pretest',{'answers':[q['answer'] for q in self.s.bank['pretest']]})
        self.s.act(pid,'meta_pre',{'answers':[3]*13})
        return pid
    def complete(self,pid,i):
        self.s.act(pid,'new_round',{'lesson':i});self.s.act(pid,'start_teaching',{})
        self.interact(pid);r=self.s.get(pid)['rounds'][-1];self.clock[0]=r['teaching_deadline']+1
        self.s.act(pid,'start_practice',{})
        with self.assertRaises(Problem):self.s.chat(pid,{'text':'实操后不能求助学徒','request_id':'blocked'})
        self.s.act(pid,'draft',{'sql':'SELECT 1;','result':'1','note':'核对实际结果'})
        self.s.act(pid,'submit_practice',{});self.s.act(pid,'start_quiz',{})
        self.s.act(pid,'quiz',{'answers':[q['answer'] for q in self.s.bank['quizzes'][i]]})
    def test_common_preparation_then_four_formal_rounds(self):
        pid=self.baseline()
        with self.assertRaisesRegex(Problem,'分组'):self.s.act(pid,'new_round',{'lesson':0})
        self.complete(pid,4);prep=self.s.get(pid)['rounds'][0]
        self.assertEqual(prep['group'],'P');self.assertIsNone(self.s.get(pid)['group'])
        self.assertEqual(prep['quiz']['question_count'],4)
        self.assertEqual(prep['quiz']['assessment_type'],'process_practice')
        p=self.s.get(pid);p['group']='T';self.s.save(p)
        for i in range(4):
            self.assertFalse(self.s.gate(self.s.get(pid),'meta_post')['open']);self.complete(pid,i)
        p=self.s.get(pid)
        self.assertEqual([r['index'] for r in p['rounds']],[4,0,1,2,3])
        self.assertEqual([r['formal_round'] for r in p['rounds']],[None,1,2,3,4])
        self.assertEqual([r['group'] for r in p['rounds']],['P','T','T','T','T'])
        self.assertEqual(p['rounds'][-1]['quiz']['assessment_type'],'cumulative')
        self.s.act(pid,'meta_post',{'answers':[3]*13});self.assertTrue(self.s.state(pid)['has_meta_post'])
        self.assertNotIn('quiz_spec',self.s.state(pid)['rounds'][0])
    def test_cannot_skip_preparation_or_stage_sequence(self):
        pid=self.baseline();p=self.s.get(pid);p['group']='L';self.s.save(p)
        with self.assertRaisesRegex(Problem,'准备课'):self.s.act(pid,'new_round',{'lesson':0})
        with self.assertRaises(Problem):self.s.act(pid,'new_round',{'lesson':4,'stage':'practice'})
        self.s.act(pid,'new_round',{'lesson':4});self.s.act(pid,'start_teaching',{})
        with self.assertRaises(Problem):self.s.act(pid,'start_quiz',{})
        self.interact(pid)
        with self.assertRaisesRegex(Problem,'时段'):self.s.act(pid,'start_practice',{})
    def test_legacy_records_are_archived_exactly_once_without_relabelling(self):
        from course_layout import upgrade_participant,SCHEME_VERSION
        import copy
        p={'id':'legacy','name':'旧数据','scheme_version':'old/1','course_order':[3,0,1,2],
           'pretest':{'score':75},'meta_pre':{'answers':[3]*13},'meta_post':{'answers':[4]*13},'group':'L',
           'rounds':[{'index':3,'group':'T','messages':[{'content':'原始解释'}],'config':{'old':'原提示词'},'task':{'title':'旧任务'}}]}
        original=copy.deepcopy(p);self.assertTrue(upgrade_participant(p,'now'))
        self.assertEqual(p['scheme_history'][0]['record'],original);self.assertEqual(p['rounds'],[])
        self.assertEqual(p['group'],'L');self.assertTrue(p['prior_scheme_exposure'])
        self.assertEqual(p['pretest'],original['pretest']);self.assertIsNone(p['meta_post'])
        self.assertEqual(p['scheme_version'],SCHEME_VERSION);self.assertFalse(upgrade_participant(p,'later'))
        self.assertEqual(len(p['scheme_history']),1)
    def test_legacy_open_switches_do_not_open_different_workorders(self):
        import copy
        from course_layout import upgrade_config
        old=copy.deepcopy(self.s.config());old.pop('scheme_version');old['tasks'][0]['brief']='旧性别映射任务'
        old['schedules'][CLASSES[0]]['ai0']['mode']='open';new=upgrade_config(old)
        self.assertEqual(len(new['tasks']),5);self.assertNotIn('旧性别映射任务',new['tasks'][0]['brief'])
        self.assertEqual(new['schedules'][CLASSES[0]]['ai0']['mode'],'closed')
        self.assertEqual(new,upgrade_config(new));self.assertEqual(old['tasks'][0]['brief'],'旧性别映射任务')
    def test_preparation_is_common_even_if_a_group_already_exists(self):
        pid=self.baseline();p=self.s.get(pid);p['group']='L';self.s.save(p)
        self.s.act(pid,'new_round',{'lesson':4});self.s.act(pid,'start_teaching',{});self.interact(pid)
        r=self.s.get(pid)['rounds'][0];self.assertEqual(r['group'],'P')
        self.assertIn('不采用L/T',r['config']['prompts']['preparation']);self.assertEqual(r['config']['teaching_seconds'],900)


class IndependentLessonTests(unittest.TestCase):
    setUp=StudyTests.setUp
    tearDown=StudyTests.tearDown
    student=StudyTests.student
    open=StudyTests.open

    def prepare(self):
        identity=self.student('独立课次验证');p=self.s.get(identity['id'])
        p.update(group='L',scheme_version='legacy-fixture/1',pretest={'score':60},meta_pre={'answers':[3]*13});self.s.save(p)
        return identity

    def start(self,pid,i):
        self.open('ai'+str(i));self.s.act(pid,'new_round',{'lesson':i})
        r=self.s.get(pid)['rounds'][-1];self.s.act(pid,'start_teaching',{'round_id':r['id']})
        return r['id']

    def test_teacher_can_open_later_class_before_earlier_class_is_started_or_completed(self):
        pid=self.prepare()['id'];later=self.start(pid,1);earlier=self.start(pid,3)
        p=self.s.get(pid);self.assertEqual([r['index'] for r in p['rounds']],[1,3])
        self.assertTrue(all(r['phase']=='teaching' for r in p['rounds']))
        self.open('ai2','closed')
        with self.assertRaises(Problem):self.s.act(pid,'new_round',{'lesson':2})
        with self.assertRaises(Problem):self.s.act(pid,'new_round',{'lesson':True})
        with self.assertRaises(Problem):self.s.act(pid,'new_round',{'lesson':1})
        self.assertEqual(len(self.s.get(pid)['rounds']),2)

    def test_operations_target_the_chosen_class_and_preserve_other_class(self):
        from unittest.mock import patch
        pid=self.prepare()['id'];first=self.start(pid,0);second=self.start(pid,1)
        with patch('server.threading.Thread'):
            self.s.chat(pid,{'round_id':first,'text':'从学生表选择姓名列。','request_id':'synthetic-specific-lesson'})
        p=self.s.get(pid);self.assertEqual(len(p['rounds'][0]['requests']),1);self.assertEqual(len(p['rounds'][1]['requests']),0)
        self.s.active.discard(pid);self.open('practice0');self.open('posttest0')
        self.s.act(pid,'start_practice',{'round_id':first})
        self.s.act(pid,'draft',{'round_id':first,'sql':'SELECT 1;','result':'1'})
        self.clock[0]+=23;self.s.act(pid,'submit_practice',{'round_id':first});self.s.act(pid,'start_quiz',{'round_id':first})
        p=self.s.get(pid);self.assertEqual(p['rounds'][0]['submission']['elapsed_seconds'],23)
        self.s.act(pid,'quiz',{'round_id':first,'answers':[q['answer'] for q in self.s.quiz_questions(p['rounds'][0])]})
        p=self.s.get(pid);self.assertEqual(p['rounds'][0]['phase'],'done');self.assertEqual(p['rounds'][1]['phase'],'teaching')
        self.assertEqual(p['rounds'][1]['draft'],{'sql':'','result':'','note':''})
        with self.assertRaisesRegex(Problem,'课堂已切换'):self.s.act(pid,'draft',{'round_id':'invalid-old-id'})

    def test_quiz_practice_and_ai_can_start_in_any_order_with_separate_completion(self):
        pid=self.prepare()['id'];self.open('ai0','closed');self.open('practice0','closed');self.open('posttest0')
        with self.assertRaises(Problem):self.s.act(pid,'new_round',{'lesson':0,'stage':'ai'})
        self.s.act(pid,'new_round',{'lesson':0,'stage':'posttest'});r=self.s.get(pid)['rounds'][0];rid=r['id']
        self.s.act(pid,'start_quiz',{'round_id':rid})
        r=self.s.get(pid)['rounds'][0];self.assertNotIn('teaching_start',r);self.assertNotIn('practice_start',r)
        with self.assertRaises(Problem):self.s.act(pid,'start_practice',{'round_id':rid})
        self.open('practice0');self.s.act(pid,'start_practice',{'round_id':rid});self.clock[0]+=17
        answers=[q['answer'] for q in self.s.quiz_questions(r)]
        self.s.act(pid,'quiz_draft',{'round_id':rid,'answers':answers})
        self.s.act(pid,'quiz',{'round_id':rid,'answers':answers});completed=encode(self.s.get(pid)['rounds'][0]['quiz'])
        self.open('ai0');self.s.act(pid,'start_teaching',{'round_id':rid})
        StudyTests.interact(self,pid)
        self.s.act(pid,'draft',{'round_id':rid,'sql':'SELECT 1;','result':'1'});self.s.act(pid,'submit_practice',{'round_id':rid})
        p=self.s.get(pid);self.assertEqual(encode(p['rounds'][0]['quiz']),completed)
        self.assertEqual(p['rounds'][0]['submission']['elapsed_seconds'],17)
        public=self.s.state(pid)['rounds'][0];self.assertTrue(public['quiz_completed']);self.assertTrue(public['teaching_started'])
        for action in ('start_quiz','start_practice','start_teaching'):
            with self.assertRaises(Problem):self.s.act(pid,action,{'round_id':rid})
        with self.assertRaises(Problem):self.s.act(pid,'quiz',{'round_id':rid,'answers':answers})

    def test_http_question_bank_is_bound_to_round_and_compat_script_is_served(self):
        identity=self.prepare();pid=identity['id'];first=self.start(pid,0);self.start(pid,1)
        p=self.s.get(pid);p['rounds'][0].update(phase='quiz',quiz_start=self.clock[0]);self.s.save(p)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.store=self.s
        threading.Thread(target=server.serve_forever,daemon=True).start();base='http://127.0.0.1:'+str(server.server_port)
        headers={'X-Local-Key':self.s.token,'X-Participant':pid,'X-Participant-Session':identity['session_token']}
        try:
            bank=json.load(local_open(urllib.request.Request(base+'/api/questions?kind=posttest&round_id='+first,headers=headers)))
            self.assertEqual([q['text'] for q in bank],[q['text'] for q in self.s.quiz_questions(p['rounds'][0])])
            self.assertTrue(all('answer' not in q for q in bank))
            with local_open(base+'/compat.js') as response:self.assertIn(b'randomUUID',response.read())
        finally:server.shutdown();server.server_close()

    def test_final_questionnaire_requires_all_started_lessons_to_finish(self):
        pid=self.prepare()['id']
        for i in [3,0,1,2]:self.start(pid,i)
        p=self.s.get(pid)
        for r in p['rounds']:r['phase']='done'
        p['rounds'][0]['phase']='teaching';self.s.save(p);self.open('meta_post')
        self.assertFalse(self.s.gate(p,'meta_post')['open'])
        with self.assertRaises(Problem):self.s.act(pid,'meta_post',{'answers':[3]*13})

class BrowserLaunchTests(unittest.TestCase):
    def test_windows_uses_installed_browser_instead_of_default_ie(self):
        import server
        from unittest.mock import patch
        with patch.object(server.os,'name','nt'), patch.dict(server.os.environ,{'LOCALAPPDATA':'local-test'},clear=True), patch.dict(sys.modules,{'winreg':None}), patch.object(server.os.path,'isfile',side_effect=lambda p:'chrome.exe' in p), patch.object(server.shutil,'which',return_value=None), patch.object(server.subprocess,'Popen') as launch, patch.object(server.webbrowser,'open') as default:
            self.assertTrue(server.open_student_browser('http://127.0.0.1:47850/#key=synthetic'))
            args=launch.call_args[0][0]
            self.assertIn('chrome.exe',args[0]);self.assertEqual(args[1],'http://127.0.0.1:47850/#key=synthetic')
            default.assert_not_called()

    def test_missing_windows_browser_keeps_service_and_does_not_launch_ie(self):
        import server
        from unittest.mock import patch
        with patch.object(server.os,'name','nt'), patch.dict(server.os.environ,{},clear=True), patch.dict(sys.modules,{'winreg':None}), patch.object(server.shutil,'which',return_value=None), patch.object(server.os.path,'isfile',return_value=False), patch.object(server.webbrowser,'open') as default, patch('builtins.print'):
            self.assertFalse(server.open_student_browser('http://127.0.0.1:47850/'))
            default.assert_not_called()

    def test_mac_browser_behavior_is_preserved(self):
        import server
        from unittest.mock import patch
        with patch.object(server.os,'name','posix'), patch.object(server.webbrowser,'open',return_value=True) as launch:
            self.assertTrue(server.open_student_browser('http://127.0.0.1:47850/'))
            launch.assert_called_once_with('http://127.0.0.1:47850/')

if __name__=='__main__':unittest.main()
