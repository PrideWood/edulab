import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
import {z} from 'zod';

const source=ts.transpileModule(await readFile('app/api/admin/model-workbench/route.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class ApiError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
class DeepSeekError extends Error {}
function harness({authenticated=true,failIndex=-1,wait=false}={}) {
  const calls=[],saves=[];let reads=0;
  const config={model:'synthetic-model',temperature:0.7,maxTokens:4096,thinking:false};
  const modules={
    'next/server':{NextResponse:Response},'zod':{z},
    '@/lib/admin-auth':{getAuthenticatedAdmin:async()=>authenticated?{id:'admin'}:null,assertSameOrigin:request=>{if(request.headers.get('origin')!=='http://localhost')throw new ApiError(403,'ORIGIN','Origin rejected');}},
    '@/lib/http':{ApiError,errorResponse:error=>Response.json({error:{code:error.code,message:error.message}},{status:error.status??500})},
    '@/lib/shared-model':{
      getSharedModelSummary:async()=>({hasToken:true,config}),
      getSharedModelConnection:async()=>{reads++;return {baseUrl:'https://api.deepseek.com',token:'synthetic-private-key',config:{...config}};},
      saveSharedModel:async(input,admin)=>{saves.push({input,admin});return {hasToken:true,config:input.config};},
    },
    '@/lib/deepseek':{DeepSeekError,deepSeekBaseUrl:value=>{if(!value.startsWith('https://'))throw new ApiError(400,'INVALID_BASE_URL','HTTPS required');return value;},
      runDeepSeekChat:async input=>{
        const index=calls.length;calls.push(input);
        if(wait) await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
        if(index===failIndex)throw new Error('synthetic-private-key');
        await input.onAnswer(`回答 ${index}`);return {answer:`回答 ${index}`};
      }},
  };
  const exports={};vm.runInNewContext(source,{exports,Response,ReadableStream,TextEncoder,AbortController,setTimeout,clearTimeout,setInterval,clearInterval,require:name=>modules[name]});
  return {api:exports,calls,saves,get reads(){return reads;}};
}
const variants=[{name:'引导',systemPrompt:'先提问。'},{name:'分析',systemPrompt:'先结论。'}];
function request(body,origin='http://localhost') {return new Request('http://localhost/api/admin/model-workbench',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)});}
const parse=async response=>(await response.text()).split('\n\n').filter(frame=>frame.startsWith('data: ')).map(frame=>JSON.parse(frame.slice(6)));

test('comparison captures a single shared key/model/parameters, sends the identical user question and varies only system prompts',async()=>{
  const h=harness();const response=await h.api.POST(request({action:'compare',prompt:'同一问题',variants}));
  const events=await parse(response);assert.equal(h.reads,1);assert.equal(h.calls.length,2);
  assert.equal(h.calls[0].token,h.calls[1].token);assert.deepEqual(h.calls[0].messages,h.calls[1].messages);
  assert.equal(h.calls[0].messages[0].role,'user');assert.equal(h.calls[0].messages[0].content,'同一问题');
  assert.equal(h.calls[0].directModel.systemPrompt,'先提问。');assert.equal(h.calls[1].directModel.systemPrompt,'先结论。');
  for(const key of ['model','temperature','maxTokens','thinking'])assert.equal(h.calls[0].directModel[key],h.calls[1].directModel[key]);
  assert.equal(events.filter(event=>event.event==='result').length,2);assert.equal(events.at(-1).event,'done');
  assert.equal(JSON.stringify(events).includes('synthetic-private-key'),false);assert.equal(h.saves.length,0);
});

test('one failed comparison column leaves other results intact and never exposes unexpected error text',async()=>{
  const h=harness({failIndex:0});const events=await parse(await h.api.POST(request({action:'compare',prompt:'问题',variants})));
  assert.equal(events.filter(event=>event.event==='failure').length,1);assert.equal(events.find(event=>event.event==='result').index,1);
  assert.equal(JSON.stringify(events).includes('synthetic-private-key'),false);
});

test('workbench requires login and same origin; bounds and validates comparisons before any upstream call',async()=>{
  const unauth=harness({authenticated:false});assert.equal((await unauth.api.GET()).status,401);
  assert.equal((await unauth.api.POST(request({action:'compare',prompt:'问题',variants}))).status,401);
  const h=harness();assert.equal((await h.api.POST(request({action:'compare',prompt:'问题',variants},'https://other.example'))).status,403);
  for(const body of [{action:'compare',prompt:'',variants},{action:'compare',prompt:'x',variants:variants.slice(0,1)},{action:'compare',prompt:'x',variants:Array(5).fill(variants[0])}])assert.equal((await h.api.POST(request(body))).status,400);
  assert.equal(h.reads,0);assert.equal(h.calls.length,0);
});

test('cancelling the comparison stream aborts every upstream request',async()=>{
  const h=harness({wait:true});const response=await h.api.POST(request({action:'compare',prompt:'问题',variants}));
  const reader=response.body.getReader();await reader.read();await reader.cancel();
  assert.equal(h.calls.length,2);assert.ok(h.calls.every(call=>call.signal.aborted));
});
