import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { formatAgentTestFailure } from '../lib/agent-test-error.js';

async function load(file, modules = {}, globals = {}) {
  const exports = {};
  const code = ts.transpileModule(await readFile(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { exports, URL, Error, Date, TextDecoder, TextEncoder, AbortSignal,
    require: name => name === 'server-only' ? {} : name === 'node:crypto' ? crypto : modules[name], ...globals });
  return exports;
}
const sse = await load('lib/sse.ts');
const encoder = new TextEncoder();
function stream(events, size = 7) {
  const text = events.map(event => typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\r\n\r\n`).join('');
  const bytes = encoder.encode(text);
  return new ReadableStream({start(controller) {
    for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
    controller.close();
  }});
}
const response = (events, size) => new Response(stream(events, size), {headers: {'content-type':'text/event-stream'}});
const input = {token:'app-synthetic-secret-1234',baseUrl:'https://api.dify.ai/v1/',user:'isolated-user',conversationId:null,content:'记住月亮',signal:AbortSignal.timeout(10000)};
const ids = {conversation_id:'conversation-1',message_id:'message-1',task_id:'task-1'};

test('Dify streams fragmented UTF-8 and ping frames, continues the same conversation and carries no Bot ID', async () => {
  const calls = [], progress = [];
  const dify = await load('lib/dify.ts', {'@/lib/sse':sse}, {fetch:async (url, options) => {
    calls.push({url,options,body:JSON.parse(options.body)});
    return response(['event: ping\r\n\r\n', ': keep-alive\r\n\r\n',
      {...ids,event:'message',answer:'月'}, {...ids,event:'message',answer:'亮'}, {...ids,event:'message_end'}],1);
  }});
  const first = await dify.runDifyChat({...input,onProgress:async reply => progress.push(reply.answer)});
  assert.equal(first.answer,'月亮');
  assert.ok(first.completedAt);
  assert.ok(progress.includes('月'));
  assert.equal(calls[0].url,'https://api.dify.ai/v1/chat-messages');
  assert.equal(calls[0].options.headers.Authorization,`Bearer ${input.token}`);
  assert.equal(calls[0].options.redirect,'error');
  assert.equal(calls[0].body.response_mode,'streaming');
  assert.equal(calls[0].body.conversation_id,'');
  assert.equal(calls[0].body.bot_id,undefined);
  await dify.runDifyChat({...input,conversationId:first.conversationId});
  assert.equal(calls[1].body.conversation_id,'conversation-1');
  assert.equal(calls[1].body.user,calls[0].body.user);
});

test('Dify Agent closing message and message_replace replace rather than duplicate the answer', async () => {
  const dify = await load('lib/dify.ts', {'@/lib/sse':sse}, {fetch:async () => response([
    {...ids,event:'agent_thought',thought:'private reasoning'},
    {...ids,event:'agent_message',answer:'初'}, {...ids,event:'agent_message',answer:'稿'},
    {...ids,event:'message',answer:'初稿'}, {...ids,event:'message_replace',answer:'最终答案'},
    {...ids,event:'message_end'},
  ])});
  assert.equal((await dify.runDifyChat(input)).answer,'最终答案');
});

test('Dify HTTP and SSE errors redact keys; dropped streams never become completed replies', async () => {
  let events;
  const dify = await load('lib/dify.ts', {'@/lib/sse':sse}, {fetch:async () => events
    ? response(events) : Response.json({code:input.token,message:`invalid ${input.token}`},{status:401})});
  await assert.rejects(()=>dify.runDifyChat(input),error=>error.status===401 && error.definitive && !error.message.includes(input.token) && !error.code.includes(input.token));
  events=[{event:'error',status:400,code:'bad_request',message:`Bearer ${input.token}`}];
  await assert.rejects(()=>dify.runDifyChat(input),error=>error.definitive && !error.message.includes(input.token));
  events=[{...ids,event:'message',answer:'尚未完成'}];
  await assert.rejects(()=>dify.runDifyChat(input),error=>error.code==='STREAM_INTERRUPTED' && !error.definitive);
  events=[{...ids,conversation_id:'wrong-conversation',event:'message',answer:'不得合并'}];
  await assert.rejects(()=>dify.runDifyChat({...input,conversationId:'conversation-1'}),error=>error.code==='CONVERSATION_MISMATCH');
  for(const value of ['http://api.dify.ai/v1','https://key@example.com/v1','https://api.dify.ai/v1?key=bad']) {
    assert.throws(()=>dify.difyBaseUrl(value));
  }
  assert.doesNotMatch(formatAgentTestFailure({status:500,message:input.token},{provider:'dify',secret:input.token}),/app-synthetic|Coze/);
});

test('Dify identities isolate reused participant codes, experiments, agents and individual conversations', async () => {
  const dify = await load('lib/dify.ts', {'@/lib/sse':sse});
  const session={experimentId:'experiment-a',participantId:'student-a',participantCode:'P001',publicId:'session-a',configSnapshot:{ai:{agentId:'agent-a'}}};
  const first=dify.difyUser(session);
  assert.equal(first,dify.difyUser({...session,participantCode:'P099'}));
  const variants=[{...session,experimentId:'experiment-b'}, {...session,participantId:'student-b'},
    {...session,publicId:'session-b'}, {...session,configSnapshot:{ai:{agentId:'agent-b'}}}];
  assert.equal(new Set([first,...variants.map(dify.difyUser)]).size,5);
  assert.doesNotMatch(first,/student-a|P001/);
});

test('history recovery binds the same user and exact message ID, never guesses by query text', async () => {
  const dify = await load('lib/dify.ts', {'@/lib/sse':sse}, {fetch:async url => {
    const parsed=new URL(url);
    assert.equal(parsed.searchParams.get('user'),'isolated-user');
    assert.equal(parsed.searchParams.get('conversation_id'),'conversation-1');
    return Response.json({data:[{id:'other',conversation_id:'conversation-1',query:'同样问题',answer:'错误回复'},
      {id:'message-1',conversation_id:'conversation-1',query:'同样问题',answer:'正确回复',status:'normal'}]});
  }});
  const recovered=await dify.findDifyMessage({...input,messageId:'message-1',conversationId:'conversation-1'});
  assert.equal(recovered.answer,'正确回复');
  assert.equal(await dify.findDifyMessage({...input,messageId:'missing',conversationId:'conversation-1'}),null);
});

test('browser displays stream deltas without recording a partial answer and rejects other sessions', async () => {
  const chat=await load('lib/chat-stream.ts', {'@/lib/sse':sse});
  const seen=[];
  const expected={sessionId:'session-a',clientRequestId:'request-a',onAnswer:answer=>seen.push(answer)};
  const start={sessionId:'session-a',clientRequestId:'request-a'};
  const result=await chat.readChatStream(response([{...start,event:'start'},
    {...start,event:'delta',answer:'答'}, {...start,event:'delta',answer:'答案'},
    {event:'completed',payload:{session:{id:'session-a'},messages:[{role:'assistant',content:'答案'}]}}]),expected);
  assert.deepEqual(seen,['答','答案']);
  assert.equal(result.messages.length,1);
  await assert.rejects(()=>chat.readChatStream(response([{...start,sessionId:'session-b',event:'delta',answer:'不得展示'}]),expected));
  await assert.rejects(()=>chat.readChatStream(response([{...start,event:'delta',answer:'未完成'}]),expected));
});
