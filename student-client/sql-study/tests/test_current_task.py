import sys,tempfile,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store,Problem
class CurrentTaskTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.s=Store(self.tmp.name,clock=lambda:1000)
 def tearDown(self):self.s.stop.set();self.tmp.cleanup()
 def person(self,name='formal'):
  identity=self.s.enter({'class_code':'2531','name':name,'confirmed':True});p=self.s.get(identity['id']);p.update(pretest={'score':60},meta_pre={'answers':[3]*13},group='L');self.s.save(p);return p
 def test_no_calendar_gate_can_prevent_current_task(self):
  p=self.person();cfg=self.s.config()
  for r in cfg['schedules']['2531'].values():r.update(mode='scheduled',open_at=9000,close_at=10000)
  self.s.put_config(cfg);self.assertTrue(self.s.gate(p,'pretest')['open']);self.assertTrue(self.s.gate(p,'meta_pre')['open']);self.assertTrue(self.s.gate(p,'ai4')['open'])
  for i in range(4):self.assertFalse(self.s.gate(p,'ai'+str(i))['open'])
  with self.assertRaises(Problem):self.s.act(p['id'],'new_round',{'lesson':0})
 def test_teacher_selects_one_task_without_prior_attendance_lock(self):
  p=self.person();cfg=self.s.config();cfg['current_lessons']['2531']=1;self.s.put_config(cfg)
  self.s.act(p['id'],'new_round',{'lesson':1});self.s.act(p['id'],'start_teaching',{});self.assertFalse(self.s.gate(self.s.get(p['id']),'ai4')['open'])
  self.assertEqual(self.s.state(p['id'])['current_lesson'],1)
 def test_switching_current_task_also_blocks_in_progress_draft_bypass(self):
  p=self.person();self.s.act(p['id'],'new_round',{'lesson':4});p=self.s.get(p['id']);r=p['rounds'][0];r.update(practice_start=1000,phase='practice');self.s.save(p)
  cfg=self.s.config();cfg['current_lessons']['2531']=0;self.s.put_config(cfg)
  with self.assertRaises(Problem):self.s.act(p['id'],'draft',{'round_id':r['id'],'sql':'old task'})
 def test_test_cleanup_creates_clean_identity_and_preserves_local_archive(self):
  p=self.person('test');p['test_cleanup_epoch']='old';self.s.save(p)
  identity=self.s.enter({'class_code':'2531','name':'test','confirmed':True});self.assertNotEqual(identity['id'],p['id']);fresh=self.s.get(identity['id']);self.assertIsNone(fresh['pretest']);self.assertEqual(fresh['rounds'],[])
  with self.s.db() as db:self.assertEqual(db.execute('SELECT count(*) FROM retired_test_students').fetchone()[0],1)
  self.assertEqual(self.s.enter({'class_code':'2531','name':'test','confirmed':True})['id'],fresh['id'])
 def test_cleanup_never_rotates_formal_student(self):
  p=self.person();p['test_cleanup_epoch']='old';self.s.save(p);again=self.s.enter({'class_code':'2531','name':'formal','confirmed':True});self.assertEqual(again['id'],p['id']);self.assertEqual(self.s.get(p['id'])['pretest'],p['pretest'])

 def test_cloud_retired_custom_test_rotates_even_after_early_login(self):
  p=self.person('custom-trial');p.update(test_identity=True,retired_by_cloud=True);self.s.save(p)
  self.assertTrue(self.s.state(p['id'])['test_reset_required'])
  fresh=self.s.enter({'class_code':'2531','name':'custom-trial','confirmed':True});self.assertNotEqual(fresh['id'],p['id']);self.assertFalse(fresh['test_reset_required'])
