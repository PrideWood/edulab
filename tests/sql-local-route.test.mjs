import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import vm from 'node:vm';import ts from 'typescript';import * as crypto from 'node:crypto';
const source=ts.transpileModule(await readFile('app/api/sql-local/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
function setup(model='deepseek-flash',production=false,failures=[]){const exports={},calls=[];class DeepSeekError extends Error{constructor(code,message,status=502){super(message);this.code=code;this.status=status;}};vm.runInNewContext(source,{exports,Response,Buffer,AbortSignal,console:{warn(){}},setTimeout:fn=>fn(),process:{env:{NODE_ENV:production?'production':'development',SQL_LOCAL_BRIDGE_TOKEN:'a'.repeat(40)}},require:name=>({'node:crypto':crypto,'@/lib/shared-model':{getSharedModelConnection:async()=>({token:'synthetic-secret',baseUrl:'https://api.deepseek.com',config:{model,maxTokens:4096}})},'@/lib/deepseek':{DeepSeekError,runDeepSeekChat:async input=>{calls.push(input);const fail=failures[calls.length-1];if(fail){if(fail.name){const error=new Error('synthetic private detail');error.name=fail.name;throw error;}throw new DeepSeekError(fail.code,'synthetic error',fail.status??502);}return {answer:'{"reply":"老师好"}'};}},'@/db':{},'@/lib/sql-study-control':{}}[name])});return {calls,post:body=>exports.POST(new Request('http://127.0.0.1:3005/api/sql-local',{method:'POST',headers:{host:'127.0.0.1:3005',authorization:'Bearer '+'a'.repeat(40),'Content-Type':'application/json'},body:JSON.stringify(body)}))};}
const messages=[{role:'system',content:'只输出JSON'},{role:'user',content:[{type:'text',text:'示例截图'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]}];
test('local bridge forwards structured JSON and supported image messages',async()=>{const h=setup();const result=await h.post({messages});assert.equal(result.status,200);assert.equal(h.calls[0].jsonOutput,true);assert.equal(h.calls[0].directModel.thinking,false);assert.deepEqual(h.calls[0].messages,messages);});
test('bridge rejects remote images, assistant images, unsupported models and remains disabled in production',async()=>{for(const input of [[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.org/private.png'}}]}],[{role:'assistant',content:messages[1].content}]]){const h=setup();assert.equal((await h.post({messages:input})).status,400);assert.equal(h.calls.length,0);}const unsupported=setup('deepseek-reasoner');assert.equal((await unsupported.post({messages})).status,400);assert.equal(unsupported.calls.length,0);assert.equal((await setup('deepseek-flash',true).post({messages})).status,403);});

test('blank finished JSON is retried within one logical model call without changing messages or strategy',async()=>{
 const h=setup('deepseek-flash',false,[{code:'EMPTY_ANSWER'}]);const response=await h.post({messages});const out=await response.json();
 assert.equal(response.status,200);assert.equal(h.calls.length,2);assert.equal(out.diagnostics.attempts,2);
 assert.equal(h.calls[0].messages,h.calls[1].messages);assert.equal(h.calls[1].directModel.maxTokens,4096);
 assert.equal(h.calls[0].signal,h.calls[1].signal);
});
test('recovery stops after three empty generations and returns a specific safe diagnostic',async()=>{
 const h=setup('deepseek-flash',false,Array(3).fill({code:'EMPTY_ANSWER'}));const response=await h.post({messages});const out=await response.json();
 assert.equal(response.status,502);assert.equal(h.calls.length,3);assert.equal(out.code,'EMPTY_ANSWER');assert.equal(out.attempts,3);
 assert.doesNotMatch(JSON.stringify(out),/synthetic-secret/);
});
test('explicit temporary HTTP refusals retry, while partial streams, network uncertainty and billing errors do not',async()=>{
 let h=setup('deepseek-flash',false,[{code:'DEEPSEEK_HTTP_429',status:429}]);assert.equal((await h.post({messages})).status,200);assert.equal(h.calls.length,2);
 for(const failure of [{code:'STREAM_INTERRUPTED'},{code:'DEEPSEEK_HTTP_401',status:401},{code:'DEEPSEEK_HTTP_402',status:402},{name:'TypeError'},{name:'TimeoutError'}]){
  h=setup('deepseek-flash',false,[failure]);const response=await h.post({messages});assert.equal(h.calls.length,1);assert.ok(response.status>=400);
  const out=await response.json();assert.doesNotMatch(JSON.stringify(out),/synthetic private detail|synthetic-secret/);
  if(failure.status)assert.equal(response.status,failure.status);
 }
});
