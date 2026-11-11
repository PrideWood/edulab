"""Durable practice screenshots; Python 3.8 stdlib, no cloud keys in the client."""
import base64, hashlib, json, os, secrets, uuid, urllib.request
from pathlib import Path
from test_identity import is_test_identity
FIELDS=('id','round_id','submission_id','sha256','content_md5','size_bytes','mime','status','deleted')
SERVICE='https://edulab.dacnote.com/api/sql-practice-attachments'

def install(Base,Problem):
 class AttachmentStore(Base):
  def image_metadata(self,p):
   return [{k:a.get(k) for k in FIELDS} for a in p.get('practice_attachments',[])]
  def archive(self,pid,participant=None):
   out=super().archive(pid,participant)
   out['study']=dict(out['study'])
   out['study']['practice_attachments']=self.image_metadata(out['study'])
   return out
  def public(self,p):
   out=super().public(p)
   for r in out['rounds']:
    r['practice_images']=[a for a in self.image_metadata(p) if a['round_id']==r['id'] and not a['deleted']]
   out['practice_image_policy']='one-to-three/1'
   return out
  def backup_status(self,pid):
   out=super().backup_status(pid)
   p=self.get(pid);n=sum(not a.get('deleted') and a.get('status')!='confirmed' for a in p.get('practice_attachments',[]))
   out['pending_images']=n;out['pending']+=n
   if n:out['status']='queued'
   return out
  def image_file(self,pid,image_id):
   p=self.get(pid)
   a=next((a for a in p.get('practice_attachments',[]) if a['id']==image_id and not a.get('deleted')),None)
   if not a:raise Problem('未找到本人的截图。',404)
   return (self.directory/'attachments'/(a['id']+'.bin')).read_bytes(),a['mime']
  def act(self,pid,action,data):
   with self.lock:
    if action not in ('practice_image_add','practice_image_remove','submit_practice'):return super().act(pid,action,data)
    p=self.get(pid);r=self.round_for(p,data.get('round_id'))
    if action=='submit_practice':
     if not is_test_identity(p) and not any(a['round_id']==r['id'] and not a.get('deleted') for a in p.get('practice_attachments',[])):raise Problem('请先添加至少1张本人运行结果截图。')
     return super().act(pid,action,data)
    if not self.stage_started(r,'practice') or r.get('submission'):raise Problem('只能在尚未提交的独立实操中修改截图。',409)
    if not is_test_identity(p):self.require_gate(p,'practice'+str(r['index']))
    images=p.setdefault('practice_attachments',[])
    if action=='practice_image_remove':
     a=next((a for a in images if a['id']==data.get('id') and a['round_id']==r['id'] and not a.get('deleted')),None)
     if not a:raise Problem('未找到本课截图。',404)
     a['deleted']=True
    else:
     if sum(a['round_id']==r['id'] and not a.get('deleted') for a in images)>=3:raise Problem('每次实操最多保留3张截图。')
     try:
      header,encoded=data.get('image','').split(',',1);mime={'data:image/png;base64':'image/png','data:image/jpeg;base64':'image/jpeg'}[header]
      content=base64.b64decode(encoded,validate=True)
      if not 0<len(content)<=2097152:raise ValueError()
      if not (content.startswith(b'\x89PNG\r\n\x1a\n') if mime=='image/png' else content.startswith(b'\xff\xd8\xff')):raise ValueError()
     except (ValueError,KeyError,TypeError):raise Problem('截图格式或大小不正确。')
     image_id=str(uuid.uuid4());r.setdefault('practice_submission_id',str(uuid.uuid4()))
     directory=self.directory/'attachments';directory.mkdir(exist_ok=True,mode=0o700)
     temporary=directory/(image_id+'.tmp');target=directory/(image_id+'.bin')
     with temporary.open('wb') as f:f.write(content);f.flush();os.fsync(f.fileno())
     os.replace(str(temporary),str(target))
     images.append({'id':image_id,'round_id':r['id'],'submission_id':r['practice_submission_id'],'mime':mime,'size_bytes':len(content),'sha256':hashlib.sha256(content).hexdigest(),'content_md5':base64.b64encode(hashlib.md5(content).digest()).decode(),'status':'pending','deleted':False,'token':secrets.token_urlsafe(32),'attempts':0,'next_at':0})
    self.save(p);self.backup_wake.set();return self.public(p)
  def attachment_request(self,payload):
   req=urllib.request.Request(SERVICE,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'})
   from cloud_connection import NoRedirect
   with urllib.request.build_opener(NoRedirect).open(req,timeout=25) as response:return json.loads(response.read(16000))
  def upload_attachment(self,p,a):
   from cloud_connection import CloudConnection,NoRedirect
   content,mime=self.image_file(p['id'],a['id'])
   if hashlib.sha256(content).hexdigest()!=a['sha256']:raise ValueError('Local screenshot changed')
   cloud=CloudConnection(self.connection())
   cloud.query('SELECT edulab_local_backup.register_practice_attachment($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::text,$7::int,$8::text,$9::text,$10::text)',[self.setting('device'),p['id'],a['round_id'],a['submission_id'],a['id'],a['sha256'],a['size_bytes'],mime,hashlib.sha256(a['token'].encode()).hexdigest(),a['content_md5']])
   payload={'id':a['id'],'token':a['token'],'action':'ticket'};ticket=self.attachment_request(payload)
   if ticket.get('status')!='confirmed':
    from urllib.parse import urlsplit
    url=ticket['url'];host=urlsplit(url).hostname or ''
    if not url.startswith('https://') or not host.endswith('.myqcloud.com'):raise ValueError('Invalid upload endpoint')
    req=urllib.request.Request(url,data=content,method='PUT',headers={'Content-Type':mime,'Content-MD5':a['content_md5']})
    with urllib.request.build_opener(NoRedirect).open(req,timeout=25) as response:
     if response.status not in (200,201,204):raise ValueError('Upload incomplete')
    payload['action']='confirm';ticket=self.attachment_request(payload)
   if ticket.get('id')!=a['id'] or ticket.get('status')!='confirmed':raise ValueError('Screenshot not confirmed')
  def backup_once(self):
   worked=super().backup_once()
   if self.connection().get('source')!='windows-direct':return worked
   with self.lock,self.db() as db:
    candidate=None
    for row in db.execute('SELECT data FROM students'):
     p=json.loads(row[0])
     if p.get('retired_by_cloud'):continue
     a=next((a for a in p.get('practice_attachments',[]) if not a.get('deleted') and a['status']!='confirmed' and a.get('next_at',0)<=self.clock()),None)
     if a:candidate=(p,a);break
   if not candidate:return worked
   p,a=candidate;confirmed=False
   try:self.upload_attachment(p,a);confirmed=True
   except Exception:pass # Files and authorization remain durable; never log signed URLs.
   with self.lock:
    current=self.get(p['id']);item=next(x for x in current['practice_attachments'] if x['id']==a['id'])
    if confirmed:item['status']='confirmed'
    else:item['attempts']=item.get('attempts',0)+1;item['next_at']=self.clock()+min(60,2**min(item['attempts'],6))
    self.save(current)
   return True
 return AttachmentStore
