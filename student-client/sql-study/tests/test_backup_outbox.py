import copy,json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from server import Store
from cloud_connection import CloudConnection

class BackupOutboxTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.now=[1000.0];self.s=Store(self.temp.name,clock=lambda:self.now[0]);self.s.connection=lambda:{'source':'windows-direct'}
        self.pid=self.s.enter({'class_code':'2531','name':'测试','confirmed':True})['id']
    def tearDown(self):self.s.stop.set();self.temp.cleanup()
    def rows(self):
        with self.s.db() as db:return [dict(r) for r in db.execute('SELECT * FROM backups ORDER BY rowid')]
    def test_save_and_full_snapshot_are_atomic_and_session_secret_is_excluded(self):
        p=self.s.get(self.pid);p['sample']='new durable value';self.s.save(p)
        latest=self.rows()[-1];payload=json.loads(latest['payload']);self.assertEqual(payload['study']['sample'],p['sample']);self.assertNotIn('session_hash',payload['study']);self.assertTrue(self.s.backup_wake.is_set())
        old=self.s.get(self.pid);changed=copy.deepcopy(old);changed['sample']='must roll back'
        with patch.object(self.s,'_queue_snapshot',side_effect=RuntimeError('disk failure')):
            with self.assertRaises(RuntimeError):self.s.save(changed)
        self.assertEqual(self.s.get(self.pid),old)
    def test_unsent_snapshots_coalesce_without_losing_events(self):
        for i in range(8):
            p=self.s.get(self.pid);p.setdefault('events',[]).append({'type':'synthetic','index':i});self.s.save(p)
        rows=self.rows();self.assertEqual(sum(r['status']=='queued' for r in rows),1)
        latest=json.loads(rows[-1]['payload']);self.assertEqual(len([e for e in latest['study']['events'] if e['type']=='synthetic']),8)
    def test_backup_during_active_reply_requires_matching_cloud_receipt(self):
        self.s.active.add(self.pid);self.s.queue(self.pid)
        def upload(_connection,row):return {'ok':True,'upload_id':row['id'],'sha256':row['sha256']}
        with patch.object(CloudConnection,'__init__',lambda self,config:None),patch.object(CloudConnection,'upload',upload):self.assertTrue(self.s.backup_once())
        self.assertEqual(self.s.backup_status(self.pid)['status'],'uploaded');self.assertEqual(self.s.backup_status(self.pid)['pending'],0)
        p=self.s.get(self.pid);p['sample']='next';self.s.save(p)
        with patch.object(CloudConnection,'__init__',lambda self,config:None),patch.object(CloudConnection,'upload',return_value={'ok':True,'upload_id':'wrong','sha256':'wrong'}):self.s.backup_once()
        self.assertEqual(self.s.backup_status(self.pid)['pending'],1);self.assertNotEqual(self.s.backup_status(self.pid)['status'],'uploaded')
    def test_failed_upload_retries_after_restart_and_manual_retry(self):
        with patch.object(CloudConnection,'__init__',lambda self,config:None),patch.object(CloudConnection,'upload',side_effect=OSError('offline')):self.s.backup_once()
        self.assertEqual(self.s.backup_status(self.pid)['pending'],1)
        self.s.stop.set();self.s=Store(self.temp.name,clock=lambda:self.now[0]);self.s.connection=lambda:{'source':'windows-direct'};self.s.retry_backup(self.pid)
        def upload(_connection,row):return {'ok':True,'upload_id':row['id'],'sha256':row['sha256']}
        with patch.object(CloudConnection,'__init__',lambda self,config:None),patch.object(CloudConnection,'upload',upload):self.s.backup_once()
        self.assertEqual(self.s.backup_status(self.pid)['status'],'uploaded')
    def test_partial_pretest_draft_is_backed_up_but_cannot_be_submitted(self):
        answers=['A']+['']*19;self.s.act(self.pid,'measurement_draft',{'kind':'pretest','answers':answers})
        latest=json.loads(self.rows()[-1]['payload']);self.assertEqual(latest['study']['measurement_drafts']['pretest'],answers)
        with self.assertRaises(Exception):self.s.act(self.pid,'pretest',{'answers':answers})

    def test_latest_confirmed_recovery_snapshot_is_kept_without_duplicate_archive_growth(self):
        def upload(_connection,row):return {'ok':True,'upload_id':row['id'],'sha256':row['sha256']}
        with patch.object(CloudConnection,'__init__',lambda self,config:None),patch.object(CloudConnection,'upload',upload):
            self.s.backup_once();p=self.s.get(self.pid);p['sample']='newest';self.s.save(p);self.s.backup_once()
        rows=self.rows();confirmed=[r for r in rows if r['status']=='uploaded'];self.assertEqual(len(confirmed),2);self.assertEqual(confirmed[0]['payload'],'');self.assertEqual(json.loads(confirmed[-1]['payload'])['study']['sample'],'newest');self.assertTrue(all(r['sha256'] for r in confirmed));self.assertEqual(self.s.get(self.pid)['sample'],'newest')
