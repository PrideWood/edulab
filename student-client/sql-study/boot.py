"""Portable entry point. Keep progress visible before importing the application."""
import os,sys,traceback,time
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
folder=Path(os.environ.get('LOCALAPPDATA',str(Path.home())))/'EduLab-SQL'
folder.mkdir(parents=True,exist_ok=True)
logfile=open(folder/'startup-diagnostic.log','a',encoding='utf-8',buffering=1)
class Tee:
    def __init__(self,original):self.original=original
    def write(self,value):
        logfile.write(value)
        if self.original:self.original.write(value);self.original.flush()
    def flush(self):
        logfile.flush()
        if self.original:self.original.flush()
sys.stdout=Tee(sys.stdout);sys.stderr=Tee(sys.stderr)
print('\n[1/4] EduLab SQL 0.15.0 portable startup '+time.strftime('%Y-%m-%d %H:%M:%S'),flush=True)
print('[INFO] Diagnostic log: '+str(folder/'startup-diagnostic.log'),flush=True)
try:
    import sqlite3,ssl
    print('[OK] Python, SQLite and TLS loaded.',flush=True)
    import server
    server.main()
except BaseException:
    traceback.print_exc()
    print('[FAILED] Copy startup-diagnostic.log for support. Online fallback: https://edulab.dacnote.com/sql-student',flush=True)
    raise
finally:logfile.flush()
