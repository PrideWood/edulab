import sys,tempfile,time,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store,Problem
from test_identity import is_test_name
class TestAccountAccessTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.s=Store(self.temp.name)
 def tearDown(self):self.s.stop.set();self.temp.cleanup()
 def enter(self,name='测试1'):return self.s.enter({'name':name,'class_code':'2531','confirmed':True})['id']
 def chat(self,pid,rid,text,request='repeatable-across-lessons'):
  self.s.chat(pid,{'round_id':rid,'request_id':request,'text':text})
  for _ in range(300):
   if pid not in self.s.active:return
   time.sleep(.01)
  self.fail('Reply did not finish')
 def test_numbered_names_and_normal_names_are_distinct(self):
  for name in ['测试','测试1','测试２','测试_12','TEST-2','ceshi 3','柴博泉']:self.assertTrue(is_test_name(name),name)
  for name in ['张三','Testa','张测试1','测试课程正式学生']:self.assertFalse(is_test_name(name),name)
 def test_all_test_entries_open_without_fabricating_baseline(self):
  pid=self.enter();state=self.s.state(pid);self.assertTrue(state['is_test']);self.assertFalse(state['has_pretest']);self.assertFalse(state['has_meta_pre'])
  for key,value in state['gates'].items():self.assertTrue(value['open'],key)
  self.s.act(pid,'new_round',{'lesson':0,'stage':'posttest'});rid=self.s.get(pid)['rounds'][0]['id'];self.s.act(pid,'start_quiz',{'round_id':rid});self.assertIsNone(self.s.get(pid)['pretest'])
  self.s.act(pid,'new_round',{'lesson':2,'stage':'practice'});rid=self.s.get(pid)['rounds'][1]['id'];self.s.act(pid,'start_practice',{'round_id':rid})
  self.s.act(pid,'meta_pre',{'answers':[3]*13});self.s.act(pid,'meta_post',{'answers':[4]*13});self.assertIsNone(self.s.get(pid)['pretest']);self.assertEqual(self.s.get(pid)['meta_pre']['answers'],[3]*13)
 def test_formal_identity_cannot_spoof_testing_from_input(self):
  p=self.s.enter({'name':'正式学生','class_code':'2531','confirmed':True,'is_test':True,'test_identity':True});self.assertFalse(p['is_test']);self.assertFalse(p['gates']['ai0']['open'])
  with self.assertRaises(Problem):self.s.act(p['id'],'new_round',{'lesson':0})
 def test_each_lesson_has_fresh_context_and_round_scoped_replies(self):
  pid=self.enter('测试2');contexts=[]
  self.s.connection=lambda:{'token':'synthetic'}
  def model(r,c):
   contexts.append((r['index'],[m['content'] for m in r['messages']],copy.deepcopy(r['knowledge'])))
   return {'reply':'当前课回复','target':0,'reason':'context test','knowledge':{},'source':'synthetic'}
  self.s.model_call=model
  for lesson,text in [(4,'P0_ONLY_MARKER'),(0,'T1_ONLY_MARKER')]:
   self.s.act(pid,'new_round',{'lesson':lesson});p=self.s.get(pid);r=p['rounds'][-1];r['config']['mode']='real';self.s.save(p);self.s.act(pid,'start_teaching',{'round_id':r['id']});self.chat(pid,r['id'],text)
  p=self.s.get(pid);self.assertNotEqual(p['rounds'][0]['id'],p['rounds'][1]['id']);self.assertEqual(len(contexts),2);self.assertNotIn('P0_ONLY_MARKER',contexts[1][1]);self.assertEqual(contexts[1][2],{})
  for r in p['rounds']:self.assertEqual(r['requests'][0]['status'],'completed');self.assertEqual(len([m for m in r['messages'] if m['role']=='assistant']),2)

 def test_automatic_entry_never_resets_new_test_mode_conversations(self):
  pid=self.enter();self.s.act(pid,'new_round',{'lesson':0});p=self.s.get(pid);before=copy.deepcopy(p['rounds']);self.assertFalse(self.s.apply_test_lesson_command(p,{'automatic_entry':True}));self.assertEqual(p['rounds'],before)
