"""Restricted Neon SQL transport for the Windows classroom package (stdlib only)."""
import json
import urllib.request
import urllib.parse

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):return None

class CloudConnection:
    def __init__(self,config):
        self.url=config['database_url']
        host=urllib.parse.urlsplit(self.url).hostname or ''
        if not host.endswith('.neon.tech'):raise ValueError('Invalid cloud endpoint')
        self.endpoint='https://'+host+'/sql'
    def __repr__(self):return '<CloudConnection credentials=hidden>'
    def query(self,sql,params):
        payload=json.dumps({'query':sql,'params':params},ensure_ascii=False).encode()
        req=urllib.request.Request(self.endpoint,data=payload,headers={'Content-Type':'application/json','Neon-Connection-String':self.url,'Neon-Raw-Text-Output':'true','Neon-Array-Mode':'false'})
        with urllib.request.build_opener(NoRedirect).open(req,timeout=20) as response:out=json.loads(response.read(20000000))
        return out['rows']
    def sync(self,device):
        value=self.query('SELECT edulab_local_backup.sql_student_sync($1::uuid) AS payload',[device])[0]['payload']
        return json.loads(value) if isinstance(value,str) else value
    def upload(self,row):
        archive=json.loads(row['payload']);canonical={k:v for k,v in archive.items() if k!='exported_at'}
        value=self.query('SELECT edulab_local_backup.ingest($1::text,$2::text,$3::text,$4::text) AS receipt',[row['id'],row['sha256'],json.dumps(canonical,ensure_ascii=False,separators=(',',':')),archive['exported_at']])[0]['receipt']
        return json.loads(value) if isinstance(value,str) else value
