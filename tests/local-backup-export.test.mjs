import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import * as fflate from 'fflate';

const modules=Object.fromEntries(await Promise.all(['lib/local-backup-export.ts','app/api/admin/local-backups/route.ts'].map(async path=>[path,ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText])));
const d='12345678-1234-4234-8234-123456789012',p='abcdefab-1234-4234-8234-123456789012';
const d2='12345678-1234-4234-8234-123456789013';
const ref={deviceId:d,participantId:p};
class ApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const archive={schema_version:'edulab-light/1',participant:{id:p,name:'测试'},conversations:[{id:'conversation',messages:[{role:'user',content:'学生原文',turn_index:1,sequence_no:1},{role:'assistant',content:'**AI原文**',turn_index:1,sequence_no:2}],requests:[{turn_index:1,requested_at:'2026-10-27T01:00:00Z',provider_chat_id:'chat-id'}]}]};
function setup({admin=true,initialized=true,rows,zip=fflate.zipSync}={}){
  const queries=[];
  const defaultRow={device_id:d,participant_id:p,participant_name:'测试',class_code:'3',source_app:'student-light',archive,selected_count:'1',total_bytes:'1000'};
  const query=async(sql,params=[])=>{queries.push({sql,params});return sql.includes('to_regclass')?{rows:[{relation:initialized?'exists':null}]}:{rows:rows??[defaultRow]};};
  const http={ApiError,errorResponse:e=>Response.json({error:{code:e.code,message:e.message}},{status:e.status||500})};
  const load=(path,deps)=>{const exports={};vm.runInNewContext(modules[path],{exports,require:name=>{if(name==='server-only')return {};if(name in deps)return deps[name];throw new Error('Unexpected dependency '+name);},Response,URL,Uint8Array});return exports;};
  const library=load('lib/local-backup-export.ts',{'fflate':{...fflate,zipSync:zip},'@/db':{query},'@/lib/http':http});
  const route=load('app/api/admin/local-backups/route.ts',{'zod':{z},'@/lib/admin-auth':{getAuthenticatedAdmin:async()=>admin?{id:'admin'}:null,assertSameOrigin:r=>{if(r.headers.get('Origin')!=='http://localhost')throw new ApiError(403,'INVALID_ORIGIN','origin');}},'@/lib/http':http,'@/lib/local-backup-export':library,'@/lib/local-backups':{}});
  return {queries,build:library.buildLocalBackupZip,post:(body,origin='http://localhost')=>route.POST(new Request('http://localhost/api/admin/local-backups',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:typeof body==='string'?body:JSON.stringify(body)}))};
}
test('local ZIP export requires admin and same origin before querying data',async()=>{
  const missing=setup({admin:false});assert.equal((await missing.post({records:[ref]})).status,401);assert.equal(missing.queries.length,0);
  const foreign=setup();assert.equal((await foreign.post({records:[ref]},'https://foreign.invalid')).status,403);assert.equal(foreign.queries.length,0);
});
test('invalid and oversized selections cannot trigger database reads',async()=>{
  for(const body of ['not-json',{records:[]},{records:[{deviceId:d}]},{records:[{deviceId:'invalid',participantId:p}]},{records:Array(501).fill(ref)}]){
    const h=setup();assert.equal((await h.post(body)).status,400);assert.equal(h.queries.length,0);
  }
});
test('ZIP contains unchanged full archives with student, AI, turn indices and request metadata',async()=>{
  const h=setup();const response=await h.post({records:[ref,ref,{deviceId:d.toUpperCase(),participantId:p.toUpperCase()}]});
  assert.equal(response.status,200);assert.equal(response.headers.get('Content-Type'),'application/zip');assert.equal(response.headers.get('X-EduLab-Export-Count'),'1');assert.match(response.headers.get('Cache-Control'),/no-store/);
  const files=fflate.unzipSync(new Uint8Array(await response.arrayBuffer()));assert.equal(Object.keys(files).length,1);assert.ok(Object.keys(files)[0].includes('测试'));
  assert.deepEqual(JSON.parse(fflate.strFromU8(Object.values(files)[0])),archive);
  const params=h.queries.at(-1).params;assert.deepEqual(Array.from(params[0]),[d]);assert.deepEqual(Array.from(params[1]),[p]);
});
test('same-name participants from different devices remain separate and unsafe names cannot escape ZIP folders',async()=>{
  const rows=[d,d2].map(device=>({device_id:device,participant_id:p,participant_name:'../../测试\\name',class_code:'../3',source_app:'student-light',archive:{...archive,device_id:device},selected_count:'2',total_bytes:'2000'}));
  const h=setup({rows});const result=await h.build([ref,{deviceId:d2,participantId:p}]);const files=fflate.unzipSync(result.bytes);
  assert.equal(Object.keys(files).length,2);for(const name of Object.keys(files)){assert.ok(!name.includes('..'));assert.ok(!name.includes('\\'));}
  assert.deepEqual(Object.values(files).map(file=>JSON.parse(fflate.strFromU8(file)).device_id).sort(),[d,d2]);
});
test('missing records or schema never silently produce a partial ZIP',async()=>{
  const h=setup();assert.equal((await h.post({records:[ref,{deviceId:d2,participantId:p}]})).status,404);
  const missing=setup({initialized:false});assert.equal((await missing.post({records:[ref]})).status,404);
});
test('oversized raw or compressed exports fail clearly for safe batch retry',async()=>{
  const big=setup({rows:[{selected_count:'1',total_bytes:String(65*1024*1024)}]});assert.equal((await big.post({records:[ref]})).status,413);
  const compressed=setup({zip:()=>new Uint8Array(4_000_001)});assert.equal((await compressed.post({records:[ref]})).status,413);
});
