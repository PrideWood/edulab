import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const source=ts.transpileModule(await readFile('lib/dify-chat.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2017}}).outputText;
test('Dify thinking sends SSE heartbeat comments, and disconnect clears the timer without resending the request',async()=>{
  let tick,rejectProvider,created=0;
  const cleared=[],afterTasks=[];
  class DifyChatError extends Error{}
  const modules={
    'server-only':{},'next/server':{after:callback=>afterTasks.push(callback())},
    '@/db':{query:async()=>({rows:[]})},'@/lib/coze':{},'@/lib/transcript':{},'@/lib/session-memory':{},
    '@/lib/experiment-settings':{getRuntimeAiConfig:async()=>({token:'synthetic'})},
    '@/lib/dify':{DifyChatError,difyUser:()=> 'synthetic-user',runDifyChat:()=>{created++;return new Promise((_,reject)=>{rejectProvider=reject;});}},
  };
  const exports={};
  vm.runInNewContext(source,{exports,ReadableStream,Response,TextEncoder,AbortSignal,Date,
    setInterval:(callback,delay)=>{assert.equal(delay,10000);tick=callback;return 42;},
    clearInterval:id=>cleared.push(id),require:name=>{assert.ok(name in modules,name);return modules[name];}});
  const response=exports.createDifyChatResponse({publicId:'session-a'},{clientRequestId:'request-a'},'question',async()=>({}));
  const reader=response.body.getReader(),decoder=new TextDecoder();
  assert.match(decoder.decode((await reader.read()).value),/"event":"start"/);
  tick();assert.equal(decoder.decode((await reader.read()).value),': keep-alive\n\n');
  await reader.cancel();assert.ok(cleared.includes(42));
  rejectProvider(new Error('synthetic upstream interruption'));
  await Promise.all(afterTasks);
  assert.equal(created,1);
});
