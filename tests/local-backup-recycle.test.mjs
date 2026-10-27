import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';
import {randomUUID} from 'node:crypto';

const sources=Object.fromEntries(await Promise.all(['lib/local-backup-recycle.ts','app/api/admin/local-backups/route.ts'].map(async path=>[path,ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText])));
const deviceId='abcdefab-1234-4234-8234-123456789012',participantId='12345678-1234-4234-8234-123456789012',record={deviceId,participantId};
class ApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
function load(path,deps){const exports={};vm.runInNewContext(sources[path],{exports,require:name=>{if(name==='server-only')return {};if(name in deps)return deps[name];throw new Error('Unexpected dependency '+name);},Response,URL});return exports;}
function setup({admin=true,ready=true,found=1,changed=1}={}){
  const calls=[];let transactions=0;
  const query=async(sql,params=[])=>{calls.push({sql,params});
    if(sql.includes('to_regclass'))return {rows:[{backups:'exists',disposition:ready?'exists':null}]};
    if(sql.includes('SELECT p.device_id'))return {rows:Array(found).fill({device_id:deviceId,participant_id:participantId})};
    return {rows:[],rowCount:changed};
  };
  const http={ApiError,errorResponse:e=>Response.json({error:{code:e.code,message:e.message}},{status:e.status||500})};
  const lib=load('lib/local-backup-recycle.ts',{'node:crypto':{randomUUID},'@/db':{transaction:async work=>{transactions++;return work({query});}},'@/lib/http':http});
  const route=load('app/api/admin/local-backups/route.ts',{'zod':{z},'@/lib/http':http,'@/lib/local-backup-export':{},'@/lib/local-backups':{},'@/lib/local-backup-recycle':lib,'@/lib/admin-auth':{getAuthenticatedAdmin:async()=>admin?{id:'trusted-admin'}:null,assertSameOrigin:r=>{if(r.headers.get('Origin')!=='http://localhost')throw new ApiError(403,'INVALID_ORIGIN','origin');}}});
  return {calls,transactions:()=>transactions,patch:(body,origin='http://localhost')=>route.PATCH(new Request('http://localhost/api/admin/local-backups',{method:'PATCH',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)}))};
}
const input={records:[record],action:'trash',confirmation:'移入回收站'};
test('recycle mutation requires admin, same origin and explicit action-specific confirmation',async()=>{
  let h=setup({admin:false});assert.equal((await h.patch(input)).status,401);assert.equal(h.transactions(),0);
  h=setup();assert.equal((await h.patch(input,'https://foreign.invalid')).status,403);assert.equal(h.transactions(),0);
  for(const body of [{...input,confirmation:''},{...input,action:'restore'},{...input,records:[]},{...input,records:Array(501).fill(record)},{...input,records:[{deviceId:'invalid',participantId}]}]){
    const instance=setup();assert.equal((await instance.patch(body)).status,400);assert.equal(instance.transactions(),0);
  }
});
test('trash normalizes duplicate composite identities and records trusted admin audit without deleting snapshots',async()=>{
  const h=setup();const response=await h.patch({...input,records:[record,{deviceId:deviceId.toUpperCase(),participantId}],adminId:'forged'});
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{action:'trash',selectedCount:1,changedCount:1});
  const mutation=h.calls.find(x=>x.sql.includes('INSERT INTO public.local_backup_dispositions'));
  assert.deepEqual(Array.from(mutation.params[0]),[deviceId]);assert.equal(mutation.params[2],'trusted-admin');
  assert.ok(h.calls.some(x=>x.sql.includes('admin_audit_log')&&x.params[2]==='local.backup.trash'));
  assert.ok(h.calls.every(x=>!/^\s*DELETE\b/i.test(x.sql)));
});
test('restore updates only the disposition; duplicate requests are idempotent and no audit is fabricated',async()=>{
  const h=setup({changed:0});const response=await h.patch({...input,action:'restore',confirmation:'恢复记录'});assert.equal(response.status,200);
  assert.equal((await response.json()).changedCount,0);assert.ok(h.calls.some(x=>x.sql.includes('SET is_trashed=false')));assert.ok(!h.calls.some(x=>x.sql.includes('admin_audit_log')));
});
test('missing migration or any missing selection fails before all mutation writes',async()=>{
  const missing=setup({ready:false});assert.equal((await missing.patch(input)).status,503);
  const absent=setup({found:0});assert.equal((await absent.patch(input)).status,404);assert.ok(!absent.calls.some(x=>x.sql.includes('INSERT INTO')));
});
