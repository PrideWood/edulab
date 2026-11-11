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
    def person(self,name='正式学生'):
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
    def test_p0_has_no_upper_limit_and_requires_ten_successes(self):
        pid=self.start('T')
        for i in range(9):self.chat(pid,str(i),text='解释该检查点')
        with self.assertRaises(Problem):self.s.act(pid,'finish_dialogue',{})
        self.chat(pid,'tenth')
        self.assertTrue(self.s.state(pid)['rounds'][0]['dialogue']['can_finish'])
        for i in range(10,24):self.chat(pid,str(i))
        d=self.s.state(pid)['rounds'][0]['dialogue'];self.assertEqual(d['completed_turns'],24);self.assertIsNone(d['max_turns']);self.assertTrue(d['can_send'])
        self.assertNotIn('dialogue_end',self.s.get(pid)['rounds'][0])

    def test_formal_has_twelve_distinct_fixed_slots(self):
        pid=self.start('T',0)
        for i in range(12):self.chat(pid,str(i))
        r=self.s.get(pid)['rounds'][0];self.assertIn(r['config']['research_questions'][0][6],r['messages'][14]['content'])
        self.assertIsNone(self.s.state(pid)['rounds'][0]['dialogue']['max_turns'])
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
    def test_ten_turns_unlock_before_suggested_time_without_waiting(self):
        pid=self.start()
        for i in range(9):self.chat(pid,str(i))
        for action in ['finish_dialogue','mental_effort','start_practice']:
            with self.assertRaises(Problem):self.s.act(pid,action,{'value':5})
        self.chat(pid,'10');self.s.act(pid,'finish_dialogue',{})
        self.s.act(pid,'mental_effort',{'value':7});self.s.act(pid,'start_practice',{})
        self.assertEqual(self.clock[0],1000);self.assertEqual(self.s.get(pid)['rounds'][0]['mental_effort']['value'],7)
        self.assertEqual(self.s.state(pid)['rounds'][0]['messages'],[])

    def test_required_effort_rejects_skip_and_cannot_overwrite(self):
        pid=self.start()
        for i in range(10):self.chat(pid,str(i))
        self.s.act(pid,'finish_dialogue',{})
        for body in [{'value':v} for v in [0,10,True,5.5,None]]+[{'skipped':True}]:
            with self.assertRaises(Problem):self.s.act(pid,'mental_effort',body)
        self.s.act(pid,'mental_effort',{'value':5})
        with self.assertRaises(Problem):self.s.act(pid,'mental_effort',{'value':6})
        self.s.act(pid,'start_practice',{})

    def test_advisory_expiry_neither_closes_chat_nor_caps_recorded_time(self):
        pid=self.start();self.chat(pid,'one');p=self.s.get(pid);r=p['rounds'][0]
        r['teaching_clock']['elapsed_seconds']=r['config']['teaching_seconds']+100;self.s.save(p)
        self.advance(4);self.chat(pid,'over-time')
        d=self.s.state(pid)['rounds'][0]['dialogue'];self.assertTrue(d['can_send']);self.assertFalse(d['window_ended']);self.assertGreater(d['timer_elapsed_seconds'],r['config']['teaching_seconds'])
        with self.assertRaises(Problem):self.s.act(pid,'start_practice',{})

    def test_no_prediction_required_and_submission_immutable(self):
        p=self.s.enter({'class_code':'2531','name':'必答','confirmed':True});pid=p['id'];self.open('pretest')
        with self.assertRaises(Problem):self.s.act(pid,'pretest',{'answers':['A']*19+[None]})
        self.s.act(pid,'pretest',{'answers':['A']*20})
        self.assertNotIn('prediction',self.s.get(pid)['pretest'])
        with self.assertRaises(Problem):self.s.act(pid,'pretest',{'answers':['B']*20})
        pid=self.start()
        for i in range(10):self.chat(pid,str(i))
        self.s.act(pid,'finish_dialogue',{});self.s.act(pid,'mental_effort',{'value':5});self.s.act(pid,'start_practice',{})
        self.s.act(pid,'draft',{'sql':'SELECT 1','result':'1','note':'核对行列'})
        self.s.act(pid,'submit_practice',{})
        self.assertNotIn('prediction',self.s.get(pid)['rounds'][0]['submission'])
        with self.assertRaises(Problem):self.s.act(pid,'submit_practice',{})
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
        pid=self.start();p=self.s.get(pid);r=p['rounds'][0];r.pop('dialogue_policy',None);r.pop('teaching_window_policy');r.pop('teaching_clock');r.update(teaching_deadline=900,classroom_window_start=0,dialogue_end={'reason':'time_limit','at':900},teaching_end=900)
        self.s.save(p);self.s.state(pid);r=self.s.get(pid)['rounds'][0]
        self.assertEqual(r['teaching_deadline'],1900);self.assertEqual(r['teaching_clock']['elapsed_seconds'],0);self.assertNotIn('dialogue_end',r);self.assertEqual(r['previous_teaching_window']['deadline'],900)
        r['practice_start']=1000;r.pop('teaching_window_policy');p=self.s.get(pid);p['rounds'][0]=r;self.s.save(p)
        before=copy.deepcopy(r);self.s.state(pid);self.assertEqual(self.s.get(pid)['rounds'][0],before)
    def test_meta_requires_every_item(self):
        p=self.s.enter({'class_code':'2531','name':'问卷','confirmed':True});pid=p['id'];self.open('pretest');self.open('meta_pre')
        self.s.act(pid,'pretest',{'answers':['A']*20})
        with self.assertRaises(Problem):self.s.act(pid,'meta_pre',{'answers':[4]*12+[None]})
        self.s.act(pid,'meta_pre',{'answers':[4]*13})
        self.assertEqual(self.s.get(pid)['meta_pre']['evaluation'],4)
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
        r=self.s.get(pid)['rounds'][0];self.assertNotIn('dialogue_end',r);self.assertEqual(r['requests'][-1]['status'],'completed')
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
            for i in range(9):self.chat(pid,'covered'+str(i))
        self.chat(pid,'finished');r=self.s.get(pid)['rounds'][0];self.assertNotIn('？',r['messages'][-1]['content']);self.assertNotIn('掌握',r['messages'][-1]['content'])

    def test_test_names_bypass_group_allocation_but_keep_baselines(self):
        for name in ['测试','test','柴博泉']:
            p=self.s.enter({'class_code':'2531','name':name,'confirmed':True});pid=p['id']
            self.assertTrue(p['group_assigned']);self.assertFalse(p['gates']['ai4']['open'])
            self.s.act(pid,'pretest',{'answers':['A']*20});self.s.act(pid,'meta_pre',{'answers':[3]*13})
            self.s.act(pid,'new_round',{'lesson':4});self.s.act(pid,'start_teaching',{})
            self.chat(pid,'test-reply');self.assertEqual(self.s.get(pid)['rounds'][0]['requests'][-1]['status'],'completed')
