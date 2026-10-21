import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(await readFile('lib/client-api.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
function load(fetch){
  const exports={};
  vm.runInNewContext(code,{exports,fetch,Error,TypeError,setTimeout:callback=>{callback();return 0;},
    require:()=>({timeoutSignal:()=>new AbortController().signal})});
  return exports;
}
test('HTML gateway errors are readable and retry the identical registration body after a committed-but-lost reply',async()=>{
  const calls=[];let retries=0;
  const api=load(async(url,options)=>{calls.push({url,...options});return calls.length===1?new Response('<html>Gateway timeout</html>',{status:504}):Response.json({session:{id:'committed-session'}});});
  const body=JSON.stringify({registrationRequestId:'same-persistent-id',profile:{fullName:'Synthetic'}});
  assert.deepEqual(JSON.parse(JSON.stringify(await api.registerParticipant('/api/sessions?entry=test',body,()=>retries++))),{session:{id:'committed-session'}});
  assert.equal(retries,1);assert.equal(calls.length,2);
  assert.ok(calls.every(call=>call.body===body&&call.method==='POST'));
});
test('persistent HTML and malformed responses stop after bounded retries without exposing a JSON syntax error',async()=>{
  let calls=0;
  const api=load(async()=>{calls++;return new Response('<html>busy</html>',{status:200});});
  await assert.rejects(()=>api.registerParticipant('/api/sessions','{}',()=>{}),error=>error.code==='INVALID_RESPONSE'&&error.status===502&&!error.message.includes('Unexpected token'));
  assert.equal(calls,3);
});
test('a duplicate identity or invalid entry is not automatically resubmitted',async()=>{
  let calls=0;
  const api=load(async()=>{calls++;return Response.json({error:{code:'STUDENT_NUMBER_EXISTS',message:'Use original participant'}},{status:409});});
  await assert.rejects(()=>api.registerParticipant('/api/sessions','{}',()=>{}),error=>error.code==='STUDENT_NUMBER_EXISTS');
  assert.equal(calls,1);
});
test('a temporary network failure retries safely with the same registration intent',async()=>{
  let calls=0;
  const api=load(async()=>{if(++calls===1)throw new TypeError('Failed to fetch');return Response.json({saved:true});});
  assert.equal((await api.registerParticipant('/api/sessions','{}',()=>{})).saved,true);
  assert.equal(calls,2);
});

test('HTML draft responses preserve HTTP status without leaking HTML or JSON syntax errors',async()=>{
  const api=load(()=>{throw new Error('must not replay a mutation');});
  for(const status of [200,401,403,429,502,504]) {
    await assert.rejects(()=>api.readApiJson(new Response('<html>Security Checkpoint secret-marker</html>',{status})),
      error=>error.code==='INVALID_RESPONSE'&&error.status===(status===200?502:status)
        &&!error.message.includes('Unexpected token')&&!error.message.includes('secret-marker'));
  }
});

test('genuine draft conflicts remain actionable and successful drafts retain exact text and revision',async()=>{
  const api=load(()=>{throw new Error('must not replay a mutation');});
  await assert.rejects(()=>api.readApiJson(Response.json({error:{code:'DRAFT_CONFLICT',message:'请核对草稿'}},{status:409})),
    error=>error.code==='DRAFT_CONFLICT'&&error.message==='请核对草稿');
  const saved=await api.readApiJson(Response.json({draft:{text:'下一句话',revision:3}}));
  assert.equal(saved.draft.text,'下一句话');assert.equal(saved.draft.revision,3);
});
