import sys,tempfile,time,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store,Problem
class RestartResumeTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.now=[1000.0];self.s=Store(self.temp.name,clock=lambda:self.now[0]);self.entered=self.s.enter({'class_code':'2531','name':'张三','confirmed':True});self.pid=self.entered['id'];self.s.act(self.pid,'pretest',{'answers':['A']*20});self.s.act(self.pid,'meta_pre',{'answers':[3]*13});p=self.s.get(self.pid);p['group']='L';self.s.save(p);self.s.act(self.pid,'new_round',{'lesson':4});self.s.act(self.pid,'start_teaching',{});self.rid=self.s.get(self.pid)['rounds'][0]['id']
 def tearDown(self):self.s.stop.set();self.temp.cleanup()
 def chat(self,n):
  self.s.chat(self.pid,{'request_id':str(n),'round_id':self.rid,'text':'这条说明属于当前准备课。'})
  for _ in range(300):
   if self.pid not in self.s.active:return
   time.sleep(.005)
  self.fail('Reply did not finish')
 def restart(self):
  self.s.stop.set();self.now[0]+=300;self.s=Store(self.temp.name,clock=lambda:self.now[0]);p=self.s.enter({'class_code':'2531','name':'张三','confirmed':True});self.assertEqual(p['id'],self.pid);self.assertTrue(p['has_pretest']);self.assertTrue(p['has_meta_pre']);return p
 def test_same_name_resumes_conversation_and_interrupted_request_without_reset(self):
  self.chat(1);self.s.act(self.pid,'teaching_presence',{'active':True,'view_id':'resume','sequence':1});self.now[0]+=2;self.s.state(self.pid);p=self.s.get(self.pid);r=p['rounds'][0];r['requests'].append({'id':'interrupted','status':'running','turn_index':2});r['messages'].append({'id':'pending-message','role':'user','content':'尚未收到回复','request_id':'interrupted'});self.s.save(p);elapsed=r['teaching_clock']['elapsed_seconds']
  resumed=self.restart();self.assertNotEqual(resumed['session_token'],self.entered['session_token']);r=self.s.get(self.pid)['rounds'][0];self.assertEqual(r['id'],self.rid);self.assertEqual(r['requests'][-1]['status'],'interrupted');self.assertEqual(r['messages'][-1]['content'],'尚未收到回复');self.assertEqual(r['teaching_clock']['elapsed_seconds'],elapsed);self.assertEqual(resumed['rounds'][0]['dialogue']['completed_turns'],1)
 def test_practice_draft_survives_service_restart(self):
  for n in range(10):self.chat(n)
  self.s.act(self.pid,'finish_dialogue',{});self.s.act(self.pid,'mental_effort',{'value':5});self.s.act(self.pid,'start_practice',{});draft={'sql':'SELECT 姓名 FROM 学生表;','result':'本人结果','note':'已核验'};self.s.act(self.pid,'draft',draft);self.restart();r=self.s.get(self.pid)['rounds'][0];self.assertEqual(r['draft'],draft);self.assertEqual(r['phase'],'practice');self.assertEqual(r['id'],self.rid)
 def test_quiz_draft_and_original_identity_survive_restart(self):
  for n in range(10):self.chat(n)
  self.s.act(self.pid,'finish_dialogue',{});self.s.act(self.pid,'mental_effort',{'value':5});self.s.act(self.pid,'start_practice',{});self.s.act(self.pid,'draft',{'sql':'SELECT 1','result':'1','note':'已核验'});self.s.act(self.pid,'practice_image_add',{'image':'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nXcAAAAASUVORK5CYII='});self.s.act(self.pid,'submit_practice',{});self.s.act(self.pid,'start_quiz',{});answers=['A']+['']*(len(self.s.quiz_questions(self.s.get(self.pid)['rounds'][0]))-1);self.s.act(self.pid,'quiz_draft',{'answers':answers});self.restart();r=self.s.get(self.pid)['rounds'][0];self.assertEqual(r['draft_quiz']['answers'],answers);self.assertIsNone(r.get('quiz'));other=self.s.enter({'class_code':'2532','name':'张三','confirmed':True});self.assertNotEqual(other['id'],self.pid)
