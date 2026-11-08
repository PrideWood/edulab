import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

async function load(file, modules={}, globals={}) {
  const exports={};
  vm.runInNewContext(ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,URL,Error,Date,TextDecoder,AbortSignal,require:name=>name==='server-only'?{}:modules[name],...globals});
  return exports;
}
const sse=await load('lib/sse.ts');
const config={model:'deepseek-flash',systemPrompt:'只给提示，不直接给答案。',temperature:0.3,maxTokens:4096,thinking:false};
const input={token:'sk-synthetic-key-123456789',baseUrl:'https://api.deepseek.com/',directModel:config,
  messages:[{role:'user',content:'上一轮问题'},{role:'assistant',content:'上一轮回答'},{role:'user',content:'本轮问题'}],signal:AbortSignal.timeout(10000)};
function stream(events) {
  const bytes=new TextEncoder().encode(events.map(event=>`data: ${typeof event==='string'?event:JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({start(controller){for(const byte of bytes) controller.enqueue(new Uint8Array([byte]));controller.close();}}),{headers:{'content-type':'text/event-stream'}});
}
const chunk=(delta,finish_reason=null)=>({id:'test-reply',choices:[{delta,finish_reason}]});

test('DeepSeek sends the system prompt, full conversation, model and style parameters; fragmented SSE excludes reasoning',async()=>{
  const calls=[],answers=[];
  const api=await load('lib/deepseek.ts',{'@/lib/sse':sse},{fetch:async(url,options)=>{
    calls.push({url,options,body:JSON.parse(options.body)});
    return stream([chunk({reasoning_content:'隐藏的思考'}),chunk({content:'先'}),chunk({content:'想一想'}),chunk({},'stop'),'[DONE]']);
  }});
  const reply=await api.runDeepSeekChat({...input,onAnswer:async answer=>answers.push(answer)});
  assert.equal(reply.answer,'先想一想'); assert.ok(reply.completedAt);
  assert.deepEqual(answers,['先','先想一想']);
  assert.equal(calls[0].url,'https://api.deepseek.com/chat/completions');
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${input.token}`);
  assert.deepEqual(calls[0].body.messages,[{role:'system',content:config.systemPrompt},...input.messages]);
  assert.equal(calls[0].body.temperature,0.3); assert.equal(calls[0].body.max_tokens,4096);
  assert.equal(calls[0].body.thinking.type,'disabled');
  await api.runDeepSeekChat({...input,directModel:{...config,thinking:true}});
  assert.equal(calls[1].body.thinking.type,'enabled');
});

test('DeepSeek rejects truncated, empty, errored and token-limited streams instead of persisting a completed answer',async()=>{
  let events;
  const api=await load('lib/deepseek.ts',{'@/lib/sse':sse},{fetch:async()=>stream(events)});
  for(const value of [[chunk({content:'部分'})],[chunk({},'stop'),'[DONE]'],[chunk({content:'部分'},'length'),'[DONE]'],[{error:{message:input.token}}],['not-json']]) {
    events=value;
    await assert.rejects(()=>api.runDeepSeekChat(input),error=>!error.message.includes(input.token));
  }
});

test('DeepSeek HTTP failures never expose an upstream body or credentials; unsafe base URLs never receive the key',async()=>{
  let calls=0;
  const api=await load('lib/deepseek.ts',{'@/lib/sse':sse},{fetch:async()=>{calls++;return Response.json({message:input.token},{status:401});}});
  await assert.rejects(()=>api.runDeepSeekChat(input),error=>error.status===401&&error.definitive&&!error.message.includes(input.token));
  for(const baseUrl of ['http://remote.example','https://user:password@example.com','https://example.com?token=abc','https://example.com/#key']) {
    await assert.rejects(()=>api.runDeepSeekChat({...input,baseUrl}),/HTTPS/);
  }
  assert.equal(calls,1);
});

test('DeepSeek recovery finalizes a durable completion once, never sends another model request, and expires interrupted requests',async()=>{
  const completed={answer:'已保存的完整回答',messageId:'reply-1',replyStartedAt:new Date().toISOString(),completedAt:new Date().toISOString()};
  const rows=[{id:'request-1',client_request_id:'client-1',turn_index:1,requested_at:new Date().toISOString(),metadata:{deepseek_completed_reply:completed,user_content:'问题',user_sequence:1}},
    {id:'request-2',client_request_id:'client-2',turn_index:2,requested_at:new Date(Date.now()-130000).toISOString(),metadata:{}}];
  let finalized=false,persisted=0; const failed=[];
  const client={query:async(sql)=>{
    if(sql.startsWith('SELECT status')) return {rows:[{status:finalized?'completed':'in_progress',metadata:rows[0].metadata}]};
    if(sql.includes('RETURNING next_sequence')) return {rows:[{sequence:2}]};
    if(sql.includes("SET status='completed'")) finalized=true;
    return {rows:[]};
  }};
  const api=await load('lib/deepseek-chat.ts',{
    'next/server':{},'@/db':{query:async()=>({rows}),transaction:async work=>work(client)},
    '@/lib/coze':{markRequestFailed:async(...args)=>failed.push(args)},'@/lib/experiment-settings':{},
    '@/lib/messages':{listMessages:async()=>[]},'@/lib/transcript':{persistTranscript:async(_client,_id,messages)=>{persisted++;assert.equal(messages[1].content,completed.answer);assert.equal(messages[1].provider,'deepseek');}},
    '@/lib/deepseek':{},
  });
  assert.equal((await api.recoverDeepSeekPendingRequest({id:'session-1'})).pending,false);
  await api.recoverDeepSeekPendingRequest({id:'session-1'});
  assert.equal(persisted,1); assert.equal(failed[0][4],'uncertain');
});

test('JSON mode and image content are forwarded only when requested',async()=>{
  let body;
  const api=await load('lib/deepseek.ts',{'@/lib/sse':sse},{fetch:async(_url,options)=>{body=JSON.parse(options.body);return stream([chunk({content:'{"reply":"老师好"}'}),chunk({},'stop'),'[DONE]']);}});
  const messages=[{role:'user',content:[{type:'text',text:'示例截图'},{type:'image_url',image_url:{url:'data:image/png;base64,c3ludGhldGlj'}}]}];
  await api.runDeepSeekChat({...input,messages,jsonOutput:true});
  assert.equal(body.response_format.type,'json_object');assert.deepEqual(body.messages.at(-1),messages[0]);
  await api.runDeepSeekChat({...input});assert.equal(body.response_format,undefined);
});
