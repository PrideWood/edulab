import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const code=ts.transpileModule(await readFile('lib/chat-recovery.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
class ClientApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
const exports={};
vm.runInNewContext(code,{exports,Error,Date,setTimeout:callback=>{callback();return 0;},require:()=>({ClientApiError})});
const {recoverChatResponse}=exports;
const payload=(messages=[],pending=false,failedRequest=null)=>({session:{id:'session-a'},messages,pending,failedRequest});
const user={role:'user',clientRequestId:'request-a',turnIndex:2};
const answer={role:'assistant',clientRequestId:null,turnIndex:2};
function options(read){return {sessionId:'session-a',clientRequestId:'request-a',read,onPayload:()=>{},isCurrent:()=>true};}

test('several broken recovery reads still find the original completed answer without sending any POST',async()=>{
  let reads=0;
  const result=await recoverChatResponse(options(async()=>{
    if(++reads<=3)throw new ClientApiError(504,'INVALID_RESPONSE','temporary HTML');
    if(reads===4)return payload([user],true);
    return payload([user,answer]);
  }));
  assert.equal(result.state,'completed');assert.equal(reads,5);
});
test('a prior answer cannot falsely confirm the newly interrupted request',async()=>{
  let reads=0;
  const old=[{...user,clientRequestId:'older-request',turnIndex:1},{...answer,turnIndex:1}];
  const result=await recoverChatResponse(options(async()=>{reads++;return payload(old);}));
  assert.equal(result.state,'unconfirmed');assert.equal(reads,4);
});
test('a failure is matched to its exact client request ID and retains unsafe-to-retry decisions',async()=>{
  const failed={clientRequestId:'request-a',content:'question',message:'uncertain',retryable:false};
  const result=await recoverChatResponse(options(async()=>payload([user],false,failed)));
  assert.equal(result.state,'failed');assert.equal(result.payload.failedRequest.retryable,false);
});
test('an old failed request does not stop recovery of a different request',async()=>{
  let reads=0;
  const result=await recoverChatResponse(options(async()=>++reads===1
    ?payload([],false,{clientRequestId:'older-request',retryable:true})
    :payload([user,answer])));
  assert.equal(result.state,'completed');assert.equal(reads,2);
});
test('authentication failure stops immediately instead of retrying or accepting another session',async()=>{
  await assert.rejects(()=>recoverChatResponse(options(async()=>{throw new ClientApiError(401,'SESSION_REPLACED','stale');})),error=>error.code==='SESSION_REPLACED');
  await assert.rejects(()=>recoverChatResponse(options(async()=>({...payload(),session:{id:'another-session'}}))),error=>error.code==='SESSION_REPLACED');
});
test('permanent network outage has a bounded recovery window and never confirms persistence',async()=>{
  let reads=0;
  const result=await recoverChatResponse(options(async()=>{reads++;throw new TypeError('Failed to fetch');}));
  assert.equal(result.state,'unconfirmed');assert.equal(result.payload,null);assert.equal(reads,40);
});
test('switching sessions during an outstanding read cannot overwrite the new session',async()=>{
  let current=true,applied=false;
  const config=options(async()=>{current=false;return payload([user,answer]);});
  config.isCurrent=()=>current;config.onPayload=()=>{applied=true;};
  assert.equal((await recoverChatResponse(config)).state,'cancelled');assert.equal(applied,false);
});
