import sys,tempfile,unittest,copy
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store
from prepare_live_classroom import prepare
class LiveClassroomStartupTests(unittest.TestCase):
 def setUp(self):self.temp=tempfile.TemporaryDirectory();self.s=Store(self.temp.name)
 def tearDown(self):self.s.stop.set();self.temp.cleanup()
 def person(self,name):return self.s.enter({'class_code':'2531','name':name,'confirmed':True})['id']
 def ready(self):
  self.s.connection=lambda:{'token':'synthetic','model':'synthetic'}
  def sync():
   c=self.s.config();c['mode']='real';self.s.put_config(c);return True
  self.s.sync_cloud_control=sync
 def test_prior_test_demo_is_archived_but_formal_and_live_rounds_are_preserved(self):
  pid=self.person('测试91');self.s.act(pid,'new_round',{'lesson':4});p=self.s.get(pid);rid=p['rounds'][0]['id'];p['rounds'][0]['messages']=[{'role':'assistant','content':'旧演示'}];self.s.save(p)
  self.s.act(pid,'new_round',{'lesson':0});p=self.s.get(pid);p['rounds'][1]['config']['mode']='real';live=p['rounds'][1]['id'];self.s.save(p)
  formal=self.person('普通姓名');p=self.s.get(formal);p['pretest']={'score':70};p['meta_pre']={'answers':[3]*13};p['group']='L';self.s.save(p);self.s.act(formal,'new_round',{'lesson':4});before=copy.deepcopy(self.s.get(formal)['rounds'])
  self.ready();self.assertEqual(prepare(self.s),1);p=self.s.get(pid);self.assertEqual([r['id'] for r in p['rounds']],[live]);self.assertEqual(p['test_lesson_history'][-1]['rounds'][0]['id'],rid);self.assertEqual(p['test_lesson_history'][-1]['rounds'][0]['messages'][0]['content'],'旧演示');self.assertEqual(self.s.get(formal)['rounds'],before);self.assertEqual(prepare(self.s),0)
 def test_missing_cloud_or_demo_configuration_stops_startup(self):
  self.s.connection=lambda:{'token':'synthetic','model':'synthetic'};self.s.sync_cloud_control=lambda:False
  with self.assertRaisesRegex(RuntimeError,'CLOUD_SYNC_UNAVAILABLE'):prepare(self.s)
  self.s.sync_cloud_control=lambda:True
  with self.assertRaisesRegex(RuntimeError,'CLOUD_MODEL_NOT_REAL'):prepare(self.s)
