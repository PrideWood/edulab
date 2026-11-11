import json,sys,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import server
class ConnectionPriorityTests(unittest.TestCase):
 def test_bundled_direct_config_wins_over_stale_local_bridge(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);(root/'.private').mkdir()
   direct={'source':'windows-direct','database_url':'synthetic-restricted-db','token':'synthetic-model-token'}
   (root/'.private/runtime.json').write_text(json.dumps(direct));(root/'.private/bridge.json').write_text(json.dumps({'source':'edulab-local-bridge','base_url':'http://127.0.0.1:3005'}))
   with patch.object(server,'ROOT',root),patch.object(server,'CONFIG_ROOT',root):self.assertEqual(server.Store.connection(None),direct)
   # Even an unreadable old bridge cannot disable the bundled direct path.
   (root/'.private/bridge.json').write_text('invalid retired configuration')
   with patch.object(server,'ROOT',root),patch.object(server,'CONFIG_ROOT',root):self.assertEqual(server.Store.connection(None),direct)
 def test_legacy_development_bridge_remains_available_without_direct_bundle(self):
  with tempfile.TemporaryDirectory() as folder:
   root=Path(folder);(root/'.private').mkdir();bridge={'source':'edulab-local-bridge','base_url':'http://127.0.0.1:3005'};(root/'.private/bridge.json').write_text(json.dumps(bridge))
   with patch.object(server,'ROOT',root),patch.object(server,'CONFIG_ROOT',root):self.assertEqual(server.Store.connection(None),bridge)
