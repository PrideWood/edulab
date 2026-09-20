import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';

async function load(file, modules = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(await readFile(new URL(`../${file}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, Buffer, Date, TextEncoder, AbortSignal, AbortController,
    setTimeout, clearTimeout, process: { env: { SETTINGS_ENCRYPTION_KEY: 'synthetic-test-only-encryption-key-12345' } },
    require: name => {
      if (name === 'server-only') return {};
      if (name === 'node:crypto') return crypto;
      if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
      return modules[name];
    }, ...globals });
  return exports;
}

test('encrypted runtime state survives large profiles, refresh, and cookie cleanup', async () => {
  const secrets = await load('lib/secret-crypto.ts');
  const jar = new Map();
  const runtime = await load('lib/runtime-session.ts', {
    'next/headers': { cookies: async () => ({ get: name => jar.has(name) ? { value: jar.get(name) } : undefined }) },
    '@/lib/secret-crypto': secrets,
  });
  const written = [];
  const response = { cookies: { set(name,value,options) {
    assert.ok(value.length < 3800);
    assert.equal(options.httpOnly,true);
    written.push(name);
    if (options.maxAge === 0) jar.delete(name); else jar.set(name,value);
  } } };
  const context = { version:1, expiresAt:new Date(Date.now()+60000).toISOString(),
    session:{publicId:crypto.randomUUID()},config:{},agent:{botId:'1',token:'private-key-not-for-browser'},
    profile:{fullName:'测'.repeat(80),studentNumber:'1234'},
    pendingRequest:{clientRequestId:crypto.randomUUID(),chatId:'123',conversationId:'456'},
    lastCompletedRequest:{clientRequestId:crypto.randomUUID(),chatId:'122',conversationId:'456'},
    extra:'x'.repeat(3500),
  };
  runtime.setRuntimeCookie(response,context);
  assert.match(jar.get(runtime.RUNTIME_COOKIE),/^chunks:/);
  assert.equal(JSON.stringify(await runtime.getRuntimeSession()),JSON.stringify(context));
  assert.ok(![...jar.values()].join('').includes(context.agent.token));
  // Legacy encrypted cookies remain readable after deployment.
  jar.set(runtime.RUNTIME_COOKIE,Buffer.from(JSON.stringify(secrets.encryptSecret(JSON.stringify(context)))).toString('base64url'));
  assert.equal((await runtime.getRuntimeSession()).agent.botId,'1');
  delete context.extra;
  runtime.setRuntimeCookie(response,context);
  assert.ok(!jar.has(`${runtime.RUNTIME_COOKIE}.0`));
  jar.set(runtime.RUNTIME_COOKIE,`${jar.get(runtime.RUNTIME_COOKIE)}corrupt`);
  assert.equal(await runtime.getRuntimeSession(),null);
  runtime.clearRuntimeCookie(response);
  assert.equal(jar.size,0);
  assert.ok(written.length>0);
});

test('student chat returns provider IDs immediately and recovers without creating another chat or using DB', async () => {
  const counts={create:0,retrieve:0,list:0};
  let status='in_progress';
  class CozeAPI {
    chat={
      create:async()=>{counts.create++;return {id:'chat-1',conversation_id:'conv-1',status};},
      retrieve:async()=>{counts.retrieve++;return {id:'chat-1',conversation_id:'conv-1',status};},
      messages:{list:async()=>{counts.list++;return [{id:'answer-1',role:'assistant',type:'answer',content:'OK',created_at:Math.floor(Date.now()/1000)}];}},
    };
  }
  const forbidden=()=>{throw new Error('Unexpected database access');};
  const coze=await load('lib/coze.ts',{
    '@coze/api':{CozeAPI,RoleType:{User:'user',Assistant:'assistant'},ChatStatus:{COMPLETED:'completed',FAILED:'failed',CANCELED:'canceled',REQUIRES_ACTION:'requires_action'}},
    '@/db':{query:forbidden,transaction:forbidden},'@/lib/experiment-settings':{getRuntimeAiConfig:forbidden},
  });
  const input={token:'synthetic',baseUrl:'https://example.invalid',botId:'1',cozeUserId:'synthetic',
    cozeConversationId:null,sessionPublicId:crypto.randomUUID(),clientRequestId:crypto.randomUUID(),
    content:'Hi',turnIndex:1,userSequence:1,startOnly:true};
  const started=await coze.runCozeChatWithoutDatabase(input);
  assert.equal(started.pending,true);
  assert.equal(started.chat.id,'chat-1');
  assert.deepEqual(counts,{create:1,retrieve:0,list:0});
  const recovery={...input,conversationId:'conv-1',chatId:'chat-1',requestedAt:new Date().toISOString()};
  assert.equal((await coze.recoverCozeChatWithoutDatabase(recovery)).pending,true);
  status='completed';
  const done=await coze.recoverCozeChatWithoutDatabase(recovery);
  assert.equal(done.pending,false);
  assert.equal(done.messages.find(m=>m.role==='assistant').content,'OK');
  assert.equal(counts.create,1);
  status='failed';
  await assert.rejects(()=>coze.recoverCozeChatWithoutDatabase(recovery),error=>error instanceof coze.CozeChatError);
});

test('uploads preserve both sides of each turn, split by UTF-8 bytes, and require ACK with bounded retries', async () => {
  let calls=0;
  const bodies=[];
  const uploads=await load('lib/transcript-upload.ts',{}, {
    fetch:async(_url,options)=>{
      calls++;bodies.push(JSON.parse(options.body));
      assert.equal(options.keepalive,undefined);
      if(calls===1) return {ok:false,status:503,json:async()=>({})};
      return {ok:true,status:200,json:async()=>({saved:true})};
    },
    setTimeout:callback=>{callback();return 1;},
  });
  const records=Array.from({length:12},(_,i)=>({turnIndex:Math.floor(i/2)+1,role:i%2?'assistant':'user',content:'中'.repeat(80)}));
  const chunks=uploads.transcriptChunks(records,1300);
  assert.ok(chunks.length>1);
  assert.equal(chunks.flat().length,records.length);
  for(const chunk of chunks){
    assert.ok(new TextEncoder().encode(JSON.stringify({messages:chunk})).byteLength<=1300);
    for(const turn of new Set(chunk.map(m=>m.turnIndex))) assert.equal(chunk.filter(m=>m.turnIndex===turn).length,2);
  }
  await uploads.uploadTranscript('test-session',records);
  assert.equal(calls,2);
  assert.equal(bodies[0].sessionId,'test-session');
  assert.deepEqual(bodies[0],bodies[1]);
  assert.throws(()=>uploads.transcriptChunks(records,20));
  let rejectedCalls=0;
  const rejected=await load('lib/transcript-upload.ts',{}, {fetch:async()=>{
    rejectedCalls++;return {ok:false,status:403,json:async()=>({error:{message:'Forbidden'}})};
  }});
  await assert.rejects(()=>rejected.uploadTranscript('test-session',records),/Forbidden/);
  assert.equal(rejectedCalls,1);
});
