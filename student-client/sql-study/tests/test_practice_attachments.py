import sys,tempfile,unittest,base64,json
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store,Problem
PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nXcAAAAASUVORK5CYII=')
class PracticeAttachmentsTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.s=Store(self.temp.name);self.pid=self.s.enter({'name':'测试81','class_code':'2531','confirmed':True})['id'];self.s.act(self.pid,'new_round',{'lesson':0,'stage':'practice'});self.rid=self.s.get(self.pid)['rounds'][0]['id'];self.s.act(self.pid,'start_practice',{'round_id':self.rid})
 def tearDown(self):self.temp.cleanup()
 def add(self):return self.s.act(self.pid,'practice_image_add',{'round_id':self.rid,'image':'data:image/png;base64,'+base64.b64encode(PNG).decode()})
 def test_durable_round_binding_and_private_archive(self):
  out=self.add();a=out['rounds'][0]['practice_images'][0];self.assertNotIn('token',a);self.assertEqual(self.s.image_file(self.pid,a['id'])[0],PNG);self.assertEqual(out['backup']['pending_images'],1)
  archive=json.dumps(self.s.archive(self.pid));self.assertNotIn('token',archive);self.assertNotIn(base64.b64encode(PNG).decode(),archive)
  self.s=Store(self.temp.name);self.assertEqual(self.s.state(self.pid)['rounds'][0]['practice_images'][0]['id'],a['id'])
  self.s.act(self.pid,'new_round',{'lesson':1,'stage':'practice'});self.assertEqual(self.s.state(self.pid)['rounds'][1]['practice_images'],[])
  other=self.s.enter({'name':'测试82','class_code':'2531','confirmed':True})['id']
  with self.assertRaises(Problem):self.s.image_file(other,a['id'])
 def test_limit_remove_and_invalid_file(self):
  for i in range(3):self.add()
  with self.assertRaises(Problem):self.add()
  a=self.s.get(self.pid)['practice_attachments'][0];self.s.act(self.pid,'practice_image_remove',{'round_id':self.rid,'id':a['id']});self.assertEqual(len(self.add()['rounds'][0]['practice_images']),3)
  with self.assertRaises(Problem):self.s.act(self.pid,'practice_image_add',{'round_id':self.rid,'image':'data:image/png;base64,invalid'})
 def test_submission_requirement_and_test_exception(self):
  p=self.s.get(self.pid);p['name']='正式学生';p['code']='正式学生';p['test_identity']=False
  for r in p['rounds']:r['test_identity']=False
  self.s.save(p)
  with self.assertRaisesRegex(Problem,'至少1张'):self.s.act(self.pid,'submit_practice',{'round_id':self.rid})
  p=self.s.get(self.pid);p['code']='测试81';p['test_identity']=True;self.s.save(p);self.s.act(self.pid,'draft',{'round_id':self.rid,'sql':'select 1','result':'1','note':'检查'});self.s.act(self.pid,'submit_practice',{'round_id':self.rid})
  with self.assertRaises(Problem):self.add()
 def test_retry_survives_restart_and_cloud_status_waits(self):
  self.add();self.s.connection=lambda:{'source':'windows-direct'}
  self.s.upload_attachment=lambda p,a:(_ for _ in ()).throw(OSError('offline'))
  # No text queue: exercise screenshot failure without external networking.
  with self.s.db() as db:db.execute("UPDATE backups SET status='uploaded',uploaded_at=1")
  self.assertTrue(self.s.backup_once());p=self.s.get(self.pid);self.assertEqual(p['practice_attachments'][0]['attempts'],1);self.assertNotEqual(self.s.backup_status(self.pid)['status'],'uploaded')
  self.s=Store(self.temp.name);self.assertEqual(self.s.get(self.pid)['practice_attachments'][0]['status'],'pending')
  self.s.connection=lambda:{'source':'windows-direct'};self.s.upload_attachment=lambda p,a:None
  p=self.s.get(self.pid);p['practice_attachments'][0]['next_at']=0;self.s.save(p)
  with self.s.db() as db:db.execute("UPDATE backups SET status='uploaded',uploaded_at=1")
  self.s.backup_once();self.assertEqual(self.s.get(self.pid)['practice_attachments'][0]['status'],'confirmed');self.assertGreater(self.s.backup_status(self.pid)['pending'],0)
