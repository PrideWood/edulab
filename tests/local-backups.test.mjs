import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';

const files=Object.fromEntries(await Promise.all(['lib/local-backups.ts','app/api/admin/local-backups/route.ts'].map(async path=>[path,ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText])));
const device='12345678-1234-4234-8234-123456789012',participant='abcdefab-1234-4234-8234-123456789012';
class ApiError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
function setup({authenticated=true,initialized=true,archive={participant:{name:'测试'},conversations:[]}}={}){
  const queries=[];
  const row={device_id:device,participant_id:participant,participant_name:'测试',class_code:'3',source_app:'student-light',is_test:true,revision:'7',exported_at:'2026-10-26T01:00:00Z',received_at:'2026-10-26T01:00:01Z',conversation_count:2,turn_count:'3',message_count:'6'};
  const query=async(sql,params=[])=>{queries.push({sql,params});
    if(sql.includes('to_regclass'))return {rows:[{relation:initialized?'edulab_local_backup.latest_participants':null,recycle_bin:'public.local_backup_dispositions'}]};
    if(sql.startsWith('SELECT count'))return {rows:[{total:'1'}]};
    if(sql.startsWith('SELECT archive'))return {rows:archive?[{archive}]:[]};
    return {rows:[row]};
  };
  const http={ApiError,errorResponse:error=>Response.json({error:{code:error.code,message:error.message}},{status:error.status||500})};
  function load(path,deps){const exports={};vm.runInNewContext(files[path],{exports,require:name=>{if(name==='server-only')return {};if(name in deps)return deps[name];throw new Error('Unexpected dependency '+name);},Response,URL});return exports;}
  const library=load('lib/local-backups.ts',{'@/db':{query},'@/lib/http':http});
  const route=load('app/api/admin/local-backups/route.ts',{'zod':{z},'@/lib/http':http,'@/lib/admin-auth':{getAuthenticatedAdmin:async()=>authenticated?{id:'admin'}:null},'@/lib/local-backups':library,'@/lib/local-backup-export':{},'@/lib/local-backup-recycle':{}});
  return {get:query=>route.GET(new Request('http://localhost/api/admin/local-backups'+query)),queries};
}

test('local backup endpoints require a valid admin before querying research data',async()=>{
  const h=setup({authenticated:false});assert.equal((await h.get('')).status,401);assert.equal(h.queries.length,0);
});
test('an unmigrated database returns an empty initialized=false result without breaking online participants',async()=>{
  const h=setup({initialized:false});const response=await h.get('');assert.equal(response.status,200);assert.equal((await response.json()).initialized,false);assert.equal(h.queries.length,1);
});
test('backup filters are bounded and parameterized, list omits message bodies',async()=>{
  const h=setup();const response=await h.get('?source=student-light&classCode=3&search=%27%3BDELETE&page=2');
  const body=await response.json();assert.equal(response.status,200);assert.equal(body.total,1);assert.equal(body.records[0].turnCount,3);assert.equal(body.records[0].messageCount,6);assert.equal(body.records[0].isTest,true);assert.equal('archive' in body.records[0],false);
  const list=h.queries.at(-1);assert.deepEqual(Array.from(list.params),['student-light','3',"';DELETE",false,30]);assert.ok(!list.sql.includes("';DELETE"));assert.match(response.headers.get('cache-control'),/no-store/);
});
test('invalid sources, pages and partial/composite record IDs fail before backup reads',async()=>{
  for(const suffix of ['?source=wrong','?page=0','?page=9999999','?deviceId=wrong',`?deviceId=${device}`]){
    const h=setup();assert.equal((await h.get(suffix)).status,400,suffix);assert.equal(h.queries.length,0);
  }
});
test('detail and JSON download use both device and participant keys and preserve all archive contents',async()=>{
  const archive={participant:{name:'测试'},conversations:[{messages:[{role:'user',content:'问题',turn_index:1},{role:'assistant',content:'回答',turn_index:1}]}]};
  const h=setup({archive});const response=await h.get(`?deviceId=${device}&participantId=${participant}&download=1`);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),archive);assert.match(response.headers.get('content-disposition'),/attachment/);assert.deepEqual(Array.from(h.queries.at(-1).params),[device,participant,false]);
  const missing=setup({archive:null});assert.equal((await missing.get(`?deviceId=${device}&participantId=${participant}`)).status,404);
});
test('trash view is explicitly selected and direct trash downloads cannot bypass export separation',async()=>{
  const h=setup();const response=await h.get('?view=trash');assert.equal(response.status,200);
  assert.equal(h.queries.at(-1).params[3],true);assert.match(h.queries.at(-1).sql,/local_backup_dispositions/);
  const blocked=setup();assert.equal((await blocked.get(`?deviceId=${device}&participantId=${participant}&view=trash&download=1`)).status,409);assert.equal(blocked.queries.length,0);
});
