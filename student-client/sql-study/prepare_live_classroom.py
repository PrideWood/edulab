"""Startup preparation for the certificate distribution; core client stays unchanged."""
import argparse,copy,json,os,sys
from pathlib import Path

def prepare(store):
    connection=store.connection()
    if not connection.get('token') or not connection.get('model'):
        raise RuntimeError('LIVE_MODEL_CONNECTION_MISSING')
    if not store.sync_cloud_control():raise RuntimeError('CLOUD_SYNC_UNAVAILABLE')
    if store.config().get('mode')!='real':raise RuntimeError('CLOUD_MODEL_NOT_REAL')
    from test_identity import is_test_identity
    archived=0
    with store.lock,store.db() as db:
        people=[json.loads(row[0]) for row in db.execute('SELECT data FROM students')]
    for p in people:
        if not is_test_identity(p) or p.get('retired_by_cloud'):continue
        old=[r for r in p['rounds'] if r.get('config',{}).get('mode')=='demo']
        if not old:continue
        ids={r['id'] for r in old}
        p.setdefault('test_lesson_history',[]).append({'reason':'live-model-startup/1','switched_at':__import__('server').stamp(),'rounds':copy.deepcopy(old)})
        p['rounds']=[r for r in p['rounds'] if r['id'] not in ids]
        store.event(p,'test_demo_rounds_archived_for_live_model',round_ids=sorted(ids))
        store.save(p);archived+=len(old)
    return archived

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--data-dir',type=Path);args=parser.parse_args()
    runtime=Path(__file__).resolve().parent/'runtime'
    if not (runtime/'server.py').is_file():raise RuntimeError('RUNTIME_NOT_FOUND')
    sys.path.insert(0,str(runtime))
    import server
    folder=args.data_dir or server.default_directory();folder.mkdir(parents=True,exist_ok=True)
    handle=open(folder/'service.lock','a+b')
    try:
        try:
            if os.name=='nt':
                import msvcrt
                handle.write(b'0');handle.flush();handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:raise RuntimeError('OLD_SERVICE_RUNNING_CLOSE_ITS_WINDOW_FIRST')
        store=server.Store(folder)
        try:count=prepare(store)
        finally:store.stop.set()
        print('[OK] Live classroom configuration synchronized. Test and formal accounts use the real model.',flush=True)
        print('[OK] Previous test demo rounds archived:',count,flush=True)
    finally:handle.close()

if __name__=='__main__':
    try:main()
    except Exception as error:
        known={'LIVE_MODEL_CONNECTION_MISSING','CLOUD_SYNC_UNAVAILABLE','CLOUD_MODEL_NOT_REAL','RUNTIME_NOT_FOUND','OLD_SERVICE_RUNNING_CLOSE_ITS_WINDOW_FIRST'}
        label=str(error) if str(error) in known else type(error).__name__
        print('[ERROR] Live classroom not ready: '+label+'. No demo classroom was started.',flush=True)
        sys.exit(1)
