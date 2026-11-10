import sys,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from teaching_clock import ensure_clock,tick_clock,presence,status
class ClockTests(unittest.TestCase):
 def setUp(self):
  self.r={'config':{'teaching_seconds':900},'teaching_start':0,'teaching_deadline':900,'teaching_window_policy':'foreground-active/1'};ensure_clock(self.r,0)
 def test_pause_resume_counts_only_active_foreground(self):
  r=self.r;tick_clock(r,100);self.assertEqual(r['teaching_clock']['elapsed_seconds'],0)
  presence(r,100,True,'tab',1);tick_clock(r,102);presence(r,102,False,'tab',2);tick_clock(r,2000)
  self.assertEqual(r['teaching_clock']['elapsed_seconds'],2);self.assertFalse(status(r,2000)['timer_running'])
  presence(r,2000,True,'tab',3);tick_clock(r,2003);self.assertEqual(r['teaching_clock']['elapsed_seconds'],5)
 def test_closed_or_crashed_page_cannot_keep_charging(self):
  presence(self.r,0,True,'tab',1);tick_clock(self.r,999);self.assertEqual(self.r['teaching_clock']['elapsed_seconds'],4)
 def test_old_heartbeat_does_not_restart_after_pause(self):
  presence(self.r,0,True,'tab',1);presence(self.r,2,False,'tab',3);self.assertFalse(presence(self.r,3,True,'tab',2));tick_clock(self.r,100);self.assertEqual(self.r['teaching_clock']['elapsed_seconds'],2)
 def test_switching_tabs_does_not_double_charge(self):
  presence(self.r,0,True,'a',1);presence(self.r,1,True,'b',1);presence(self.r,2,False,'a',2);tick_clock(self.r,3);self.assertEqual(self.r['teaching_clock']['elapsed_seconds'],3);self.assertTrue(status(self.r,3)['timer_running'])
