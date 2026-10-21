import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const exports = {};
vm.runInNewContext(ts.transpileModule(await readFile('lib/interaction-start.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports,Error});
const {startLoginInteraction,interactionStartKey,readInteractionStart} = exports;
function fixture() {
  const data = new Map(), calls = [];
  const storage = {getItem:key=>data.get(key) ?? null,setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)};
  return {data,calls,options:{storage,key:interactionStartKey('group-a','P001'),sessionId:randomUUID(),newRequestId:randomUUID,
    prepare:async()=>{},start:async action=>{calls.push({...action});return {id:randomUUID()};}}};
}

test('ordinary credential restore, refresh and other groups never initiate a new interaction',async()=>{
  const {options,calls} = fixture();
  options.newRequestId=()=>{throw new Error('must not allocate a request');};
  options.prepare=async()=>{throw new Error('must not prepare a new task');};
  assert.equal(await startLoginInteraction({...options,retryOnly:true}),null);
  options.storage.setItem(interactionStartKey('group-b','P001'),JSON.stringify({action:'start_interaction',clientRequestId:randomUUID(),expectedSessionId:randomUUID(),automaticLogin:true}));
  assert.equal(await startLoginInteraction({...options,retryOnly:true}),null);
  assert.equal(calls.length,0);
});

test('verified login persists a single request before preparation and clears it only after success',async()=>{
  const {options,calls,data} = fixture();
  options.prepare=async()=>assert.equal(readInteractionStart(options.storage,options.key).expectedSessionId,options.sessionId);
  const result=await startLoginInteraction(options);
  assert.ok(result.id);assert.equal(calls.length,1);assert.equal(calls[0].expectedSessionId,options.sessionId);
  assert.equal(data.size,0);
});

test('lost start response is replayed after reload using the original request and source session',async()=>{
  const {options,calls,data} = fixture();
  const committed=randomUUID();
  await assert.rejects(()=>startLoginInteraction({...options,start:async action=>{
    calls.push({...action});throw new Error('network response lost after commit');
  }}),/network response lost/);
  assert.equal(data.size,1);
  const result=await startLoginInteraction({...options,sessionId:committed,retryOnly:true,
    newRequestId:()=>{throw new Error('must reuse original request');},
    start:async action=>{calls.push({...action});return {id:committed};}});
  assert.equal(result.id,committed);
  assert.deepEqual(calls[0],calls[1]);assert.equal(data.size,0);
});

test('pending replies and unsaved drafts prevent creation and preserve the same operation for retry',async()=>{
  for (const reason of ['AI reply still pending','draft save failed']) {
    const {options,calls}=fixture();
    await assert.rejects(()=>startLoginInteraction({...options,prepare:async()=>{throw new Error(reason);}}),new RegExp(reason));
    const pending=readInteractionStart(options.storage,options.key);
    assert.equal(calls.length,0);assert.ok(pending.automaticLogin);
    await startLoginInteraction({...options,retryOnly:true});
    assert.equal(calls[0].clientRequestId,pending.clientRequestId);
  }
});

test('failed database/API save retains the intent and two simultaneous retries share its idempotency key',async()=>{
  const {options,calls}=fixture();
  await assert.rejects(()=>startLoginInteraction({...options,start:async()=>{throw new Error('database unavailable');}}),/database unavailable/);
  const pending=readInteractionStart(options.storage,options.key);
  await Promise.all([startLoginInteraction({...options,retryOnly:true}),startLoginInteraction({...options,retryOnly:true})]);
  assert.equal(calls.length,2);assert.ok(calls.every(action=>action.clientRequestId===pending.clientRequestId));
});

test('manual requests are not replayed on refresh; explicit login reuses an unfinished manual request',async()=>{
  const {options,calls}=fixture();
  const manual={action:'start_interaction',clientRequestId:randomUUID(),expectedSessionId:options.sessionId};
  options.storage.setItem(options.key,JSON.stringify(manual));
  assert.equal(await startLoginInteraction({...options,retryOnly:true}),null);
  await startLoginInteraction(options);
  assert.equal(calls.length,1);assert.equal(calls[0].clientRequestId,manual.clientRequestId);
});

test('corrupted intent and failed persistent storage cannot silently create a session',async()=>{
  const {options,calls}=fixture();
  options.storage.setItem(options.key,'{"automaticLogin":true}');
  assert.equal(await startLoginInteraction({...options,retryOnly:true}),null);
  await assert.rejects(()=>startLoginInteraction({...options,storage:{...options.storage,setItem:()=>{throw new Error('quota exceeded');}}}),/尚未开启新会话/);
  assert.equal(calls.length,0);
});
