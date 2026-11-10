import copy,json,sys,tempfile,time,unittest,threading
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store,Problem

class ResearchProtocolTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.clock=[1000.0];self.s=Store(self.tmp.name,clock=lambda:self.clock[0])
    def advance(self,seconds,pid=None):
        pid=pid or self.visible_pid
        sequence=0
        while seconds>0:
            sequence+=1;self.s.act(pid,'teaching_presence',{'active':True,'view_id':'test-clock','sequence':int(self.clock[0]*1000)+sequence})
            step=min(4,seconds);self.clock[0]+=step;seconds-=step
        self.s.state(pid)
    def tearDown(self):self.s.stop.set();self.tmp.cleanup()
    def open(self,key,**extra):self.s.schedule({'class_code':'2531','key':key,'rule':{'mode':'open',**extra}})
    def person(self,name='测试'):
        p=self.s.enter({'class_code':'2531','name':name,'confirmed':True});pid=p['id']
        self.open('pretest');self.open('meta_pre')
        self.s.act(pid,'pretest',{'answers':['A']*20,'predicted_score':70})
        self.s.act(pid,'meta_pre',{'answers':[3]*13})
        return pid
    def start(self,group='L',lesson=4):
        pid=self.person();p=self.s.get(pid);p['group']=group
        if lesson!=4:p['test_lesson_control']={'lesson':lesson,'id':'test'}
        self.s.save(p)
        for stage in ['ai','practice','posttest']:self.open(stage+str(lesson))
        self.s.act(pid,'new_round',{'lesson':lesson});self.s.act(pid,'start_teaching',{})
        self.visible_pid=pid
        self.s.act(pid,'teaching_presence',{'active':True,'view_id':'test-clock','sequence':1})
        return pid
    def chat(self,pid,rid,text='因为需要先确定来源。',**extra):
        self.s.chat(pid,{'request_id':rid,'text':text,**extra})
        for _ in range(300):
            if pid not in self.s.active:return
            time.sleep(.005)
        self.fail('async reply did not complete')
    def test_preparation_requires_assigned_group_and_keeps_same_condition(self):
        pid=self.person();self.open('ai4')
        with self.assertRaises(Problem):self.s.act(pid,'new_round',{'lesson':4})
        p=self.s.get(pid);p['group']='T';self.s.save(p)
        self.s.act(pid,'new_round',{'lesson':4});r=self.s.get(pid)['rounds'][0]
        self.assertEqual(r['group'],'T');self.assertEqual(r['research_version'],'sql-lt/1.1')
    def test_p0_six_rounds_then_one_closing_answer_never_a_seventh_question(self):
        pid=self.start('T')
        for i in range(6):self.chat(pid,str(i),text='是的')
        d=self.s.state(pid)['rounds'][0]['dialogue'];self.assertEqual(d['completed_turns'],6);self.assertTrue(d['closing_reply'])
        self.chat(pid,'final','最后一问的回答')
        r=self.s.get(pid)['rounds'][0];self.assertTrue(r['requests'][-1]['closing']);self.assertNotIn('？',r['messages'][-1]['content'])
        self.assertEqual(r['dialogue_end']['reason'],'turn_limit')
        with self.assertRaises(Problem):self.s.chat(pid,{'request_id':'overflow','text':'再问'})
        self.assertEqual(self.s.state(pid)['rounds'][0]['dialogue']['completed_turns'],6)
    def test_formal_has_twelve_distinct_fixed_slots(self):
        pid=self.start('T',0)
        for i in range(12):self.chat(pid,str(i))
        r=self.s.get(pid)['rounds'][0];self.assertIn(r['config']['research_questions'][0][6],r['messages'][14]['content'])
        self.assertEqual(self.s.state(pid)['rounds'][0]['dialogue']['max_turns'],12)
    def test_failed_retry_does_not_consume_budget_and_keeps_provenance(self):
        pid=self.start();original=self.s.infer
        def fail(r):raise Problem('simulated failure')
        self.s.infer=fail;self.chat(pid,'failed')
        self.assertEqual(self.s.state(pid)['rounds'][0]['dialogue']['completed_turns'],0)
        self.s.infer=original;self.chat(pid,'retry',retry_of='failed')
        self.assertEqual(self.s.get(pid)['rounds'][0]['requests'][-1]['turn_index'],1)
        self.assertEqual(self.s.get(pid)['rounds'][0]['requests'][-1]['retry_of'],'failed')
        self.s.chat(pid,{'request_id':'retry','text':'重复传输'})
        self.assertEqual(len(self.s.get(pid)['rounds'][0]['requests']),2)
    def test_clock_boundaries_and_effort_never_open_practice_early(self):
        pid=self.start();self.chat(pid,'first');self.s.act(pid,'finish_dialogue',{})
        with self.assertRaises(Problem):self.s.act(pid,'mental_effort',{'value':5})
        with self.assertRaises(Problem):self.s.act(pid,'start_practice',{})
        self.advance(900)
        self.assertTrue(self.s.state(pid)['rounds'][0]['dialogue']['effort_due'])
        with self.assertRaises(Problem):self.s.act(pid,'start_practice',{})
        self.s.act(pid,'mental_effort',{'value':7})
        self.s.act(pid,'start_practice',{});self.assertEqual(self.s.get(pid)['rounds'][0]['mental_effort']['value'],7)
        self.assertTrue(self.s.state(pid)['rounds'][0]['chat_locked'])
        self.assertEqual(self.s.state(pid)['rounds'][0]['messages'],[])
    def test_optional_effort_skip_is_not_middle_score_and_cannot_overwrite(self):
        pid=self.start();self.chat(pid,'one');self.advance(900)
        for value in [0,10,True,5.5]:
            with self.assertRaises(Problem):self.s.act(pid,'mental_effort',{'value':value})
        self.s.act(pid,'mental_effort',{'skipped':True,'value':None})
        self.assertIsNone(self.s.get(pid)['rounds'][0]['mental_effort']['value'])
        with self.assertRaises(Problem):self.s.act(pid,'mental_effort',{'value':5})
        self.s.act(pid,'start_practice',{})
    def test_last_minute_saves_answer_without_new_question_and_hard_deadline(self):
        pid=self.start();self.chat(pid,'one');self.advance(840);self.chat(pid,'closing','这里的理由是…')
        self.assertEqual(self.s.get(pid)['rounds'][0]['dialogue_end']['reason'],'closing_period')
        pid2=self.person('另一个');p=self.s.get(pid2);p['group']='L';self.s.save(p);self.s.act(pid2,'new_round',{'lesson':4});self.s.act(pid2,'start_teaching',{})
        self.advance(901,pid2)
        with self.assertRaises(Problem):self.s.chat(pid2,{'request_id':'late','text':'来不及'})
    def test_prediction_before_grading_and_immutable_after_submission(self):
        p=self.s.enter({'class_code':'2531','name':'预测','confirmed':True});pid=p['id'];self.open('pretest')
        for value in [-1,101,True,float('nan')]:
            with self.assertRaises(Problem):self.s.act(pid,'pretest',{'answers':['A']*20,'predicted_score':value})
        self.s.act(pid,'pretest',{'answers':['A']*20,'prediction_skipped':True})
        self.assertEqual(self.s.get(pid)['pretest']['prediction']['status'],'skipped')
        with self.assertRaises(Problem):self.s.act(pid,'pretest',{'answers':['A']*20,'predicted_score':100})
        pid=self.start();self.chat(pid,'one');self.advance(900);self.s.act(pid,'mental_effort',{'skipped':True});self.s.act(pid,'start_practice',{})
        self.s.act(pid,'draft',{'sql':'SELECT 1','result':'1','note':'核对行列'})
        with self.assertRaises(Problem):self.s.act(pid,'submit_practice',{})
        self.s.act(pid,'submit_practice',{'predicted_score':60})
        self.assertEqual(self.s.get(pid)['rounds'][0]['submission']['prediction']['value'],60)
        with self.assertRaises(Problem):self.s.act(pid,'submit_practice',{'predicted_score':100})
    def test_restart_preserves_counts_and_old_protocol_is_archived_not_relabelled(self):
        pid=self.start();self.chat(pid,'one');before=copy.deepcopy(self.s.get(pid));self.s.stop.set()
        self.s=Store(self.tmp.name,clock=lambda:self.clock[0]);self.assertEqual(self.s.get(pid)['rounds'][0]['messages'],before['rounds'][0]['messages'])
        old=self.s.get(pid);old.pop('research_version');old['rounds'][0]['group']='P';self.s.save(old);self.s.stop.set()
        self.s=Store(self.tmp.name,clock=lambda:self.clock[0]);p=self.s.get(pid)
        self.assertEqual(p['rounds'],[]);self.assertEqual(p['research_history'][-1]['rounds'][0]['group'],'P');self.assertTrue(p['prior_research_exposure'])
    def test_late_student_gets_full_personal_window(self):
        pid=self.person();p=self.s.get(pid);p['group']='L';self.s.save(p)
        self.open('ai4',open_at=1)
        self.s.act(pid,'new_round',{'lesson':4});self.s.act(pid,'start_teaching',{})
        r=self.s.get(pid)['rounds'][0]
        self.assertEqual(r['teaching_deadline'],1900)
        self.assertEqual(r['teaching_window_policy'],'foreground-active/1')
        other=self.person('late');p=self.s.get(other);p['group']='T';self.s.save(p);self.clock[0]=3000
        self.assertTrue(self.s.gate(p,'ai4')['open']);self.s.act(other,'new_round',{'lesson':4});self.s.act(other,'start_teaching',{})
        self.assertEqual(self.s.get(other)['rounds'][0]['teaching_deadline'],3900)
    def test_calendar_rules_never_block_current_task(self):
        pid=self.person();p=self.s.get(pid);p['group']='L';self.s.save(p)
        self.s.schedule({'class_code':'2531','key':'ai4','rule':{'mode':'scheduled','open_at':1100,'close_at':1200}})
        self.assertTrue(self.s.gate(p,'ai4')['open']);self.clock[0]=3000
        self.assertTrue(self.s.gate(p,'ai4')['open']);self.s.act(pid,'new_round',{'lesson':4});self.s.act(pid,'start_teaching',{})
        self.assertEqual(self.s.get(pid)['rounds'][0]['teaching_deadline'],3900)
        self.s.schedule({'class_code':'2531','key':'ai4','rule':{'mode':'closed'}});self.assertTrue(self.s.gate(self.s.get(pid),'ai4')['open'])
    def test_incomplete_old_shared_window_recovers_without_touching_completed_work(self):
        pid=self.start();p=self.s.get(pid);r=p['rounds'][0];r.pop('teaching_window_policy');r.pop('teaching_clock');r.update(teaching_deadline=900,classroom_window_start=0,dialogue_end={'reason':'time_limit','at':900},teaching_end=900)
        self.s.save(p);self.s.state(pid);r=self.s.get(pid)['rounds'][0]
        self.assertEqual(r['teaching_deadline'],1900);self.assertEqual(r['teaching_clock']['elapsed_seconds'],0);self.assertNotIn('dialogue_end',r);self.assertEqual(r['previous_teaching_window']['deadline'],900)
        r['practice_start']=1000;r.pop('teaching_window_policy');p=self.s.get(pid);p['rounds'][0]=r;self.s.save(p)
        before=copy.deepcopy(r);self.s.state(pid);self.assertEqual(self.s.get(pid)['rounds'][0],before)
    def test_optional_meta_missingness_keeps_dimension_thresholds(self):
        p=self.s.enter({'class_code':'2531','name':'问卷','confirmed':True});pid=p['id'];self.open('pretest');self.open('meta_pre')
        self.s.act(pid,'pretest',{'answers':['A']*20,'predicted_score':60})
        self.s.act(pid,'meta_pre',{'answers':[4]*6+[None]+[3]*4+[None,None]})
        q=self.s.get(pid)['meta_pre'];self.assertEqual(q['monitoring'],4);self.assertIsNone(q['evaluation']);self.assertEqual(q['evaluation_n'],4)
        with self.assertRaises(Problem):self.s.act(pid,'meta_pre',{'answers':[5]*13})
    def test_inflight_reply_cannot_introduce_question_inside_closing_minute(self):
        pid=self.start();self.advance(835);ready=threading.Event();release=threading.Event();original=self.s.infer
        def delayed(r):
            ready.set();release.wait(2);return original(r)
        self.s.infer=delayed;self.s.chat(pid,{'request_id':'slow','text':'这部分解释清楚了'})
        self.assertTrue(ready.wait(2));self.advance(10);release.set()
        for _ in range(300):
            if pid not in self.s.active:break
            time.sleep(.005)
        r=self.s.get(pid)['rounds'][0];self.assertNotIn('？',r['messages'][-1]['content']);self.assertEqual(r['dialogue_end']['reason'],'closing_period')
    def test_old_protocol_test_commands_never_replay(self):
        pid=self.person();p=self.s.get(pid)
        command={'id':'old','device_id':self.s.setting('device'),'participant_id':pid,'lesson':0,'scheme_version':'business-workorders/1','test_identity_verified':True}
        self.assertFalse(self.s.apply_test_lesson_command(p,command));command['research_version']='sql-lt/1.1';self.assertTrue(self.s.apply_test_lesson_command(p,command))
    def test_fixed_visible_question_cannot_be_replaced_by_model_adaptive_text(self):
        pid=self.start('T');self.s.infer=lambda r:{'reply':'这里模型错误地转向别的问题？','target':0,'reason':'model','knowledge':{},'source':'synthetic'}
        self.chat(pid,'first');r=self.s.get(pid)['rounds'][0]
        self.assertEqual(r['messages'][-1]['content'],r['config']['research_questions'][4][0])
        self.assertEqual(r['requests'][-1]['response_kind'],'fixed_question')
    def test_shared_coverage_acknowledgement_never_claims_mastery_or_repeats_question(self):
        for group in ['L','T']:
            pid=self.person('完成'+group);p=self.s.get(pid);p['group']=group;self.s.save(p);self.open('ai4');self.s.act(pid,'new_round',{'lesson':4});self.s.act(pid,'start_teaching',{})
            self.s.infer=lambda r:{'reply':'还要保存结果吗？','target':0,'knowledge':{str(i):{'status':'explained','evidence':'合成输入'} for i in range(6)},'source':'synthetic'}
            self.chat(pid,'finished');r=self.s.get(pid)['rounds'][0];self.assertNotIn('？',r['messages'][-1]['content']);self.assertNotIn('掌握',r['messages'][-1]['content'])
