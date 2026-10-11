import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import { z } from 'zod';
import * as fflate from 'fflate';
import { formatAgentTestFailure } from '../lib/agent-test-error.js';

// Run actual application SQL against a disposable, uniquely named schema.
// Every connection explicitly uses ONLY that schema; no public table is touched.
async function harness(db, sharedSources) {
  const files = ['config/experiment.ts', 'lib/security.ts', 'lib/secret-crypto.ts',
    'lib/session.ts', 'lib/session-usage.ts', 'lib/session-write.ts', 'lib/http.ts', 'lib/admin-auth.ts',
    'lib/participant-profile.ts', 'lib/participant-code-allocation.ts', 'lib/agent-control.ts',
    'lib/experiment-settings.ts', 'lib/experiment-limits.ts', 'lib/messages.ts', 'lib/coze.ts',
    'lib/dify.ts', 'lib/dify-chat.ts', 'lib/sse.ts', 'lib/transcript.ts', 'lib/session-payload.ts', 'lib/runtime-session.ts', 'lib/session-draft.ts',
    'lib/participant-recovery.ts', 'lib/experiment-entry.ts', 'lib/entry-links.ts', 'lib/entry-token.ts', 'lib/experiments.ts',
    'lib/admin-export.ts', 'lib/transcript-export.ts', 'lib/admin-records.ts', 'app/api/admin/agent-control/route.ts', 'app/api/admin/experiments/route.ts', 'app/api/admin/participants/route.ts',
    'app/api/participant-profile/route.ts', 'app/api/sessions/reset/route.ts', 'lib/legacy-runtime.ts', 'app/api/sessions/route.ts',
    'app/api/sessions/resume/route.ts', 'app/api/sessions/draft/route.ts',
    'app/api/sessions/complete/route.ts', 'app/api/sessions/checkpoint/route.ts', 'app/api/messages/route.ts', 'app/api/conversations/route.ts'];
  const sources = sharedSources ?? new Map(await Promise.all(files.map(async file => [file,
    ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText])));
  const jar = new Map(), cache = new Map(), chats = new Map(), creates = [], cozeConfigs = [];
  const forcedDraws = [];
  let providerPending = false;
  const difyCalls = [], difyHistory = new Map(), afterTasks = [];
  let difyMode = 'normal';
  const difyFetch = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname.endsWith('/messages')) {
      const data = [...difyHistory.values()].filter(message => message.conversation_id === parsed.searchParams.get('conversation_id') && message.user === parsed.searchParams.get('user'));
      return Response.json({data,has_more:false});
    }
    const body = JSON.parse(options.body);
    difyCalls.push({...body,authorization:options.headers.Authorization});
    if (difyMode === 'no_ids') return new Response('event: ping\n\n',{headers:{'content-type':'text/event-stream'}});
    if (difyMode === 'error') return Response.json({code:'unauthorized',message:options.headers.Authorization},{status:401});
    const conversation_id = body.conversation_id || crypto.randomUUID(), message_id = crypto.randomUUID(), task_id = crypto.randomUUID();
    difyHistory.set(message_id,{id:message_id,conversation_id,user:body.user,query:body.query,
      answer:`Dify 回复：${body.query}`,created_at:Math.floor(Date.now()/1000),status:'normal',error:null});
    const events = [{event:'message',conversation_id,message_id,task_id,answer:'Dify '},
      {event:'message',conversation_id,message_id,task_id,answer:`回复：${body.query}`}];
    if (difyMode !== 'interrupted') events.push({event:'message_end',conversation_id,message_id,task_id});
    return new Response(new ReadableStream({start(controller) {
      for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
      controller.close();
    }}),{headers:{'content-type':'text/event-stream'}});
  };
  class CozeAPI {
    constructor(config) { cozeConfigs.push(config); }
    chat = {
      create: async input => {
        creates.push(input);
        const chat = { id: crypto.randomUUID(), conversation_id: input.conversation_id ?? crypto.randomUUID(), status: providerPending ? 'in_progress' : 'completed', completed_at: Math.floor(Date.now()/1000) };
        chats.set(chat.id, { chat, content: input.additional_messages[0].content });
        return chat;
      },
      retrieve: async (_conversationId, chatId) => ({ ...chats.get(chatId).chat, status: providerPending ? 'in_progress' : 'completed' }),
      messages: { list: async (_conversationId, chatId) => [
        { id: `user-${chatId}`, role: 'user', type: 'question', content: chats.get(chatId).content, created_at: Math.floor(Date.now()/1000) },
        { id: `answer-${chatId}`, role: 'assistant', type: 'answer', content: `回复：${chats.get(chatId).content}`, created_at: Math.floor(Date.now()/1000) },
      ] },
    };
  }
  const mocks = {
    'server-only': {}, fflate, 'node:crypto': { ...crypto, randomInt: max => forcedDraws.length ? forcedDraws.shift() : crypto.randomInt(max) }, zod: { z }, '@/db': db,
    '@/lib/agent-test-error': { formatAgentTestFailure },
    '@/lib/participant-code': { isTestParticipantName: value => ['test','测试','ceshi'].includes(value.trim().toLowerCase()) },
    'next/headers': { cookies: async () => ({ get: key => jar.has(key) ? { value: jar.get(key) } : undefined }) },
    'next/server': { after: callback => afterTasks.push(callback()), NextResponse: { json: (body, options = {}) => ({ body:JSON.parse(JSON.stringify(body)), status: options.status ?? 200, cookies: { set: (key, value, opts) => opts.maxAge === 0 ? jar.delete(key) : jar.set(key, value) } }) } },
    '@coze/api': { CozeAPI, RoleType: { User:'user', Assistant:'assistant' }, ChatStatus: { COMPLETED:'completed', FAILED:'failed', CANCELED:'canceled', REQUIRES_ACTION:'requires_action' } },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    vm.runInNewContext(sources.get(file), { exports, Buffer, URL, Request, Response, ReadableStream, TextEncoder, TextDecoder, Date, Error, console, AbortSignal, AbortController, setTimeout, clearTimeout, fetch:difyFetch,
      process: { env: { EXPERIMENT_ID:'recovery-test', COZE_API_TOKEN:'synthetic-token', COZE_BOT_ID:'synthetic-bot',
        SETTINGS_ENCRYPTION_KEY:'synthetic-test-encryption-key-at-least-32', ADMIN_SESSION_SECRET:'synthetic-admin-secret-at-least-32-characters', NODE_ENV:'test' } },
      require: name => {
        if (name in mocks) return mocks[name];
        if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
        if (name === './dify-chat') return load('lib/dify-chat.ts');
        throw new Error(`Unexpected module ${name}`);
      },
    });
    return exports;
  }
  const request = (body, url = 'http://localhost/api/sessions') => ({ url, headers: new Headers({ origin:'http://localhost' }), json:async () => JSON.parse(JSON.stringify(body)) });
  return { load, jar, request, creates, cozeConfigs, sources, difyCalls, afterTasks, setDifyMode:value => { difyMode=value; }, setPending:value => { providerPending = value; },
    forceToken:value => forcedDraws.push(...[...value].map(char => 'abcdefghjkmnpqrstuvwxyz23456789'.indexOf(char))) };
}

test('recovery SQL integration preserves participants, context, drafts, assignments and idempotency', { skip: !process.env.DATABASE_URL }, async t => {
  const schema = `edulab_recovery_test_${crypto.randomBytes(8).toString('hex')}`;
  // Neon transaction pools cannot honor connection-level search_path; use
  // the same database's direct endpoint for these isolated integration tests.
  const databaseUrl = new URL(process.env.DATABASE_URL);
  databaseUrl.hostname = databaseUrl.hostname.replace('-pooler.', '.');
  const options = { connectionString:databaseUrl.toString(), connectionTimeoutMillis:10000,
    ssl:process.env.DATABASE_SSL === 'disable' ? false : process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized:true } : undefined };
  const admin = new pg.Client(options);
  await admin.connect();
  let pool;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ ...options, max:4, options:`-c search_path=${schema}` });
    assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name, schema);
    const migrations = (await readdir('db/migrations')).filter(file => file.endsWith('.sql')).sort();
    for (const file of migrations) await pool.query(await readFile(`db/migrations/${file}`, 'utf8'));
    let failMessageWrite = false, failLinkDeleteAudit = false, failKeyRotateAudit = false, failKeyWrite = false;
    const query = async (sql, values) => {
      if (failMessageWrite && /INSERT INTO messages/.test(sql)) throw new Error('synthetic database write failure');
      return pool.query(sql, values);
    };
    const db = { query, transaction:async work => {
      const client = await pool.connect();
      const facade = { query:async (sql, values) => {
        if (failMessageWrite && /INSERT INTO messages/.test(sql)) throw new Error('synthetic database write failure');
        if (failLinkDeleteAudit && /INSERT INTO admin_audit_log/.test(sql) && sql.includes('experiment.run.link.delete')) throw new Error('synthetic audit write failure');
        if (failKeyRotateAudit && /INSERT INTO admin_audit_log/.test(sql) && sql.includes('ai.agent.key.rotate')) throw new Error('synthetic key audit failure');
        if (failKeyWrite && /UPDATE ai_agent_configs SET coze_token_ciphertext/.test(sql)) throw new Error('synthetic key write failure');
        return client.query(sql, values);
      } };
      try { await client.query('BEGIN'); const value = await work(facade); await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } };
    const h = await harness(db), sessions = h.load('app/api/sessions/route.ts');
    const messages = h.load('app/api/messages/route.ts'), resume = h.load('app/api/sessions/resume/route.ts');
    const draft = h.load('app/api/sessions/draft/route.ts'), complete = h.load('app/api/sessions/complete/route.ts');
    const auth = h.load('lib/session.ts'), recovery = h.load('lib/participant-recovery.ts');
    const agentIds = [crypto.randomUUID(), crypto.randomUUID()], runId = crypto.randomUUID();
    await pool.query(`INSERT INTO ai_agent_configs (id,experiment_id,internal_name,coze_bot_id) VALUES
      ($1,'recovery-test','组A','botA'),($2,'recovery-test','组B','botB')`, agentIds);
    await pool.query(`INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,random_agent_ids,is_default)
      VALUES ($1,'recovery-test','课堂','active','balanced_random',$2,true)`, [runId, agentIds]);
    let payload, sessionId, participantId, originalCookie, originalSession;
    await t.test('first entry assigns the existing P code and persists encrypted identity plus agent snapshot', async () => {
      const created = await sessions.POST(h.request({ profile:{ fullName:'合成学生', studentNumber:'synthetic-001' } }));
      assert.equal(created.status, 201);
      payload = created.body;
      assert.equal(payload.session.participantCode, 'P001');
      originalCookie = h.jar.get('edulab_session');
      originalSession = await auth.getAuthenticatedSession();
      sessionId = originalSession.id; participantId = originalSession.participantId;
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT agent_id FROM participant_agent_assignments WHERE participant_id=$1', [participantId])).rows[0].agent_id, payload.session.agentId);
      assert.equal(JSON.stringify(payload).includes('synthetic-token'), false);
    });
    await t.test('draft persistence survives refresh and rejects a concurrent stale revision', async () => {
      assert.equal((await draft.PUT(h.request({ sessionId:payload.session.id, text:'尚未发送的草稿', revision:0 }))).status, 200);
      assert.equal((await sessions.GET()).body.draft.text, '尚未发送的草稿');
      assert.equal((await draft.PUT(h.request({ sessionId:payload.session.id, text:'覆盖尝试', revision:0 }))).status, 409);
      assert.equal((await sessions.GET()).body.draft.text, '尚未发送的草稿');
    });
    let firstRequestId;
    await t.test('a saved turn and duplicate POST have exactly one request and two ordered messages', async () => {
      firstRequestId = crypto.randomUUID();
      const sent = await messages.POST(h.request({ clientRequestId:firstRequestId, content:'记住关键词月亮' }));
      assert.equal(sent.status, 200);
      assert.deepEqual(Array.from(sent.body.messages, m => m.role), ['user','assistant']);
      const repeated = await messages.POST(h.request({ clientRequestId:firstRequestId, content:'记住关键词月亮' }));
      assert.equal(repeated.status, 200);
      assert.equal(h.creates.length, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE session_id=$1', [sessionId])).rows[0].n, 2);
      assert.equal((await sessions.GET()).body.messages.length, 2);
    });
    await t.test('bad codes and identity cannot create or disclose participant data', async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM participants')).rows[0].n;
      for (const [participantCode, identity] of [['P999','synthetic-001'], ['P001','someone-else']]) {
        const response = await resume.POST(h.request({ participantCode, identity }));
        assert.equal(response.status, 404);
        assert.equal(response.body.session, undefined);
      }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants')).rows[0].n, before);
    });
    await pool.query("UPDATE experiment_runs SET status='closed' WHERE id=$1", [runId]);
    await pool.query(`INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,fixed_agent_id,is_default) VALUES ($1,'recovery-test','新场次','active','fixed',$2,true)`, [crypto.randomUUID(), agentIds.find(id => id !== payload.session.agentId)]);
    await t.test('fresh browser resumes the same record, snapshot and draft; former credentials lose writes', async () => {
      const current = (await sessions.GET()).body;
      await draft.PUT(h.request({ sessionId:payload.session.id, text:'继续分析的草稿', revision:current.draft.revision }));
      h.jar.clear();
      assert.equal((await resume.POST(h.request({ participantCode:' p001 ', identity:'synthetic-001' }))).status, 200);
      const restored = (await sessions.GET()).body;
      assert.equal(restored.session.id, payload.session.id);
      assert.equal(restored.session.agentId, payload.session.agentId);
      assert.equal(restored.session.experimentRunId, runId);
      assert.equal(restored.messages.length, 2);
      assert.equal(restored.draft.text, '继续分析的草稿');
      assert.equal((await auth.getAuthenticatedSession()).participantId, participantId);
      await assert.rejects(() => h.load('lib/session-write.ts').sessionTransaction(originalSession, async () => {}), error => error.code === 'SESSION_REPLACED');
      const latestCookie = h.jar.get('edulab_session');
      h.jar.set('edulab_session', originalCookie);
      assert.equal(await auth.getAuthenticatedSession(), null);
      h.jar.set('edulab_session', latestCookie);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants')).rows[0].n, 1);
    });
    await t.test('follow-up AI request uses the original provider conversation and assigned bot', async () => {
      const result = await messages.POST(h.request({ clientRequestId:crypto.randomUUID(), content:'之前的关键词是什么？' }));
      assert.equal(result.status, 200);
      assert.equal(h.creates[1].conversation_id, (await sessions.GET()).body.session.cozeConversationId);
      assert.equal(h.creates[1].conversation_id, (await pool.query('SELECT coze_conversation_id FROM chat_requests WHERE client_request_id=$1', [firstRequestId])).rows[0].coze_conversation_id);
      assert.equal(h.creates[1].bot_id, originalSession.configSnapshot.ai.botId);
      assert.equal(result.body.messages.length, 4);
    });
    await t.test('disconnect during generation persists the user and recovers one reply without another create', async () => {
      h.setPending(true);
      const result = await messages.POST(h.request({ clientRequestId:crypto.randomUUID(), content:'断线测试' }));
      assert.equal(result.status, 202);
      assert.equal(result.body.messages.length, 5);
      const createCount = h.creates.length;
      h.jar.clear();
      assert.equal((await resume.POST(h.request({ participantCode:'P001', identity:'synthetic-001' }))).status, 200);
      h.setPending(false);
      const restored = (await sessions.GET()).body;
      assert.equal(restored.pending, false);
      assert.equal(restored.messages.length, 6);
      assert.equal(h.creates.length, createCount);
      assert.equal((await sessions.GET()).body.messages.length, 6);
    });
    await t.test('multiple conversations restore the selected conversation and retain family-wide limits', async () => {
      const conversations = h.load('app/api/conversations/route.ts');
      const created = await conversations.POST(h.request({ action:'create' }));
      assert.equal(created.status, 200);
      assert.equal(created.body.payload.session.agentId, payload.session.agentId);
      const secondId = created.body.payload.session.id;
      await draft.PUT(h.request({ sessionId:secondId, text:'第二个对话的草稿', revision:0 }));
      const switched = await conversations.POST(h.request({ action:'switch', sessionId:payload.session.id }));
      assert.equal(switched.status, 200);
      h.jar.clear();
      assert.equal((await resume.POST(h.request({ participantCode:'P001', identity:'synthetic-001' }))).status, 200);
      const restored = (await sessions.GET()).body;
      assert.equal(restored.session.id, payload.session.id);
      assert.equal(restored.controls.usedMessages, 3);
      assert.equal((await conversations.GET()).body.conversations.length, 2);
    });
    await t.test('database message write failure rolls back the request and never calls AI', async () => {
      failMessageWrite = true;
      const count = h.creates.length;
      const response = await messages.POST(h.request({ clientRequestId:crypto.randomUUID(), content:'无法保存' }));
      assert.equal(response.status, 500);
      assert.equal(h.creates.length, count);
      failMessageWrite = false;
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM chat_requests WHERE session_id=$1', [sessionId])).rows[0].n, 3);
    });
    await t.test('completed experiments resume as completed and repeated completion does not change timestamps', async () => {
      assert.equal((await complete.POST(h.request({ messages:[], storedMessageCount:6 }))).status, 200);
      const before = (await pool.query('SELECT completed_at FROM experiment_sessions WHERE id=$1', [sessionId])).rows[0].completed_at;
      h.jar.clear();
      assert.equal((await resume.POST(h.request({ participantCode:'P001', identity:'synthetic-001' }))).status, 200);
      assert.equal((await sessions.GET()).body.session.status, 'completed');
      assert.equal((await messages.POST(h.request({ clientRequestId:crypto.randomUUID(), content:'重新开始' }))).status, 409);
      assert.equal((await complete.POST(h.request({ messages:[] }))).status, 200);
      const after = (await pool.query('SELECT completed_at FROM experiment_sessions WHERE id=$1', [sessionId])).rows[0].completed_at;
      assert.equal(before.getTime(), after.getTime());
    });
    await t.test('concurrent participants get unique codes under the existing advisory lock', async () => {
      const allocation = h.load('lib/participant-code-allocation.ts');
      const codes = await Promise.all(Array.from({ length:12 }, () => db.transaction(client => allocation.createParticipantWithAvailableCode(client, 'recovery-test', 'P'))));
      assert.equal(new Set(codes.map(value => value.participantCode)).size, 12);
      assert.deepEqual(codes.map(value => value.participantCode).sort(), Array.from({ length:12 }, (_, i) => `P${String(i+2).padStart(3,'0')}`));
    });
    await t.test('test participants keep T numbering and name-only identity recovery', async () => {
      h.jar.clear();
      const created = await sessions.POST(h.request({ profile:{ fullName:'测试', studentNumber:'synthetic-legacy' } }));
      assert.equal(created.status, 201);
      assert.equal(created.body.session.participantCode, 'T001');
      const legacy = await auth.getAuthenticatedSession();
      await db.transaction(client => h.load('lib/participant-profile.ts').saveParticipantProfileWithClient(client,legacy.participantId,'测试',''));
      h.jar.clear();
      assert.equal((await resume.POST(h.request({ participantCode:'T001', identity:'测试' }))).status, 200);
      assert.equal((await sessions.GET()).body.session.id, created.body.session.id);
    });
    await t.test('a failed reply database commit remains recoverable and is finalized exactly once', async () => {
      const beforeCreates = h.creates.length;
      const current = await auth.getAuthenticatedSession();
      const currentSessionId = current.id;
      const coze = h.load('lib/coze.ts');
      const requestId = crypto.randomUUID();
      const begun = await coze.beginChatRequest(current, requestId, '回复写入失败测试', true);
      const chat = await coze.createCozeChat(current, begun.request.id, requestId, '回复写入失败测试');
      const finished = await coze.waitForCozeChat(current, chat);
      failMessageWrite = true;
      await assert.rejects(() => coze.finalizeCompletedRequest(currentSessionId, begun.request.id, finished.chat, finished.messages), /synthetic database write failure/);
      const saved = (await pool.query('SELECT status FROM chat_requests WHERE id=$1', [begun.request.id])).rows[0];
      assert.equal(saved.status, 'in_progress');
      assert.equal((await pool.query('SELECT active_request_id FROM experiment_sessions WHERE id=$1', [currentSessionId])).rows[0].active_request_id, begun.request.id);
      failMessageWrite = false;
      assert.equal((await sessions.GET()).body.messages.length, 2);
      assert.equal((await sessions.GET()).body.messages.length, 2);
      assert.equal(h.creates.length, beforeCreates + 1);
    });
    await t.test('browser upload cannot fabricate a server-authoritative turn', async () => {
      const checkpoint = h.load('app/api/sessions/checkpoint/route.ts');
      const payload = (await sessions.GET()).body;
      const fake = { ...payload.messages[0], sequenceNo:3, turnIndex:2, content:'伪造消息', clientRequestId:crypto.randomUUID() };
      const response = await checkpoint.POST(h.request({ messages:[fake] }));
      assert.equal(response.status, 409);
      assert.equal((await sessions.GET()).body.messages.length, 2);
    });
    await t.test('simultaneous recovery credentials authorize only the last committed recovery', async () => {
      const result = await Promise.all([recovery.recoverParticipant('T001','测试'), recovery.recoverParticipant('T001','测试')]);
      const stored = (await pool.query('SELECT session_secret_hash FROM experiment_sessions WHERE public_id=$1', [result[0].session.publicId])).rows[0].session_secret_hash;
      assert.equal(result.filter(value => value.session.sessionSecretHash === stored).length, 1);
      const stale = result.find(value => value.session.sessionSecretHash !== stored);
      await assert.rejects(() => h.load('lib/session-write.ts').sessionTransaction(stale.session, async () => {}), error => error.code === 'SESSION_REPLACED');
    });
    await t.test('legacy missing session conversation ID is repaired from durable request IDs', async () => {
      const row = (await pool.query("SELECT id,coze_conversation_id FROM experiment_sessions WHERE public_id=$1", [ (await pool.query("SELECT public_id FROM experiment_sessions s JOIN participants p ON p.id=s.participant_id WHERE p.external_code='T001'")).rows[0].public_id ])).rows[0];
      await pool.query('UPDATE experiment_sessions SET coze_conversation_id=NULL WHERE id=$1', [row.id]);
      const restored = await recovery.recoverParticipant('T001','测试');
      assert.equal(restored.session.cozeConversationId, row.coze_conversation_id);
      await pool.query('UPDATE experiment_sessions SET coze_conversation_id=NULL WHERE id=$1', [row.id]);
      await pool.query('UPDATE chat_requests SET coze_conversation_id=NULL WHERE session_id=$1', [row.id]);
      await assert.rejects(() => recovery.recoverParticipant('T001','测试'), error => error.code === 'RECOVERY_CONTEXT_MISSING');
    });
    await t.test('legacy cookie usage counts survive migration without double-counting later imports', async () => {
      const row = (await pool.query('SELECT session_secret_hash FROM experiment_sessions WHERE id=$1', [sessionId])).rows[0];
      const session = { ...originalSession, sessionSecretHash:row.session_secret_hash };
      await pool.query(`UPDATE experiment_sessions SET metadata=metadata || jsonb_build_object('legacy_usage_floor',
        jsonb_build_object('count',10,'through',now())) WHERE id=$1`, [sessionId]);
      const usage = h.load('lib/session-usage.ts');
      assert.equal((await usage.getSessionUsage(session)).count, 10);
      await pool.query(`INSERT INTO chat_requests (id,session_id,client_request_id,turn_index,status,requested_at)
        VALUES ($1,$2,$3,4,'failed',now()+interval '1 second')`, [crypto.randomUUID(),sessionId,crypto.randomUUID()]);
      assert.equal((await usage.getSessionUsage(session)).count, 11);
      await pool.query(`INSERT INTO chat_requests (id,session_id,client_request_id,turn_index,status,requested_at)
        VALUES ($1,$2,$3,5,'failed',now()-interval '1 day')`, [crypto.randomUUID(),sessionId,crypto.randomUUID()]);
      assert.equal((await usage.getSessionUsage(session)).count, 11);
    });
    await t.test('legacy rows with missing identity or disabled storage fail safely without changing records', async () => {
      const missing = await pool.query("SELECT external_code FROM participants WHERE external_code='P002'");
      await assert.rejects(() => recovery.recoverParticipant(missing.rows[0].external_code,'unknown'), error => error.code === 'RECOVERY_IDENTITY_REQUIRED');
      await pool.query(`UPDATE experiment_sessions SET config_snapshot=jsonb_set(config_snapshot,'{storage,databaseMessagesEnabled}','false'::jsonb) WHERE participant_id=$1`, [participantId]);
      // Reset only the synthetic attempt bucket so this test checks configuration, not throttling.
      await pool.query('DELETE FROM participant_recovery_attempts');
      await assert.rejects(() => recovery.recoverParticipant('P001','synthetic-001'), error => error.code === 'RECOVERY_STORAGE_DISABLED');
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM participants WHERE external_code='P001'")).rows[0].n, 1);
    });
    await t.test('recovery attempt limit is persisted and enforced', async () => {
      for (let i=0;i<4;i++) await assert.rejects(() => recovery.recoverParticipant('P001','wrong'), error => error.code === 'RECOVERY_NOT_FOUND');
      await assert.rejects(() => recovery.recoverParticipant('P001','synthetic-001'), error => error.code === 'RECOVERY_RATE_LIMIT');
    });
    const adminId = crypto.randomUUID();
    await pool.query("INSERT INTO admin_users (id,username,display_name,password_hash) VALUES ($1,'synthetic-admin','合成管理员','unused-test-hash')", [adminId]);
    const adminAuth = h.load('lib/admin-auth.ts');
    const adminToken = adminAuth.createAdminSessionToken({ id:adminId, username:'synthetic-admin', displayName:'合成管理员' });
    const asAdmin = () => h.jar.set('edulab_admin', adminToken);
    const studyApi = h.load('app/api/admin/experiments/route.ts');
    const settingsLib = h.load('lib/experiment-settings.ts');
    const control = h.load('lib/agent-control.ts');
    const entries = h.load('lib/experiment-entry.ts');
    let study, otherStudy, groups, originalSnapshot;
    await t.test('experiment creation requires admin and copies only configuration without modifying the source', async () => {
      h.jar.clear();
      assert.equal((await studyApi.GET()).status, 401);
      asAdmin();
      assert.equal((await studyApi.GET()).status, 200);
      const settings = await settingsLib.getExperimentSettings('recovery-test',false);
      await settingsLib.saveExperimentSettings({ ...settings, ai:{ baseUrl:settings.ai.baseUrl, botId:settings.ai.botId, token:'synthetic-encrypted-token' } },adminId);
      const before = (await pool.query("SELECT * FROM experiment_settings WHERE experiment_id='recovery-test'")).rows[0];
      const created = await studyApi.POST(h.request({ name:'独立实验', sourceId:'recovery-test' },'http://localhost/api/admin/experiments'));
      assert.equal(created.status, 201);
      study = created.body.created;
      const after = (await pool.query("SELECT * FROM experiment_settings WHERE experiment_id='recovery-test'")).rows[0];
      assert.deepEqual(after,before);
      const cloned = (await pool.query('SELECT * FROM experiment_settings WHERE experiment_id=$1',[study.id])).rows[0];
      assert.equal(cloned.coze_token_ciphertext,before.coze_token_ciphertext);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants WHERE experiment_id=$1',[study.id])).rows[0].n,0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM ai_agent_configs WHERE experiment_id=$1',[study.id])).rows[0].n,2);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM experiment_runs WHERE experiment_id=$1',[study.id])).rows[0].n,0);
      assert.equal(JSON.stringify(created.body).includes('synthetic-encrypted-token'),false);
      const invalid = await studyApi.POST(h.request({ name:'错误复制', sourceId:'missing-study' },'http://localhost/api/admin/experiments'));
      assert.equal(invalid.status,404);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM experiment_settings WHERE experiment_id='missing-study'")).rows[0].n,0);
      otherStudy = (await studyApi.POST(h.request({ name:'另一实验', sourceId:study.id },'http://localhost/api/admin/experiments'))).body.created;
    });
    await t.test('independent fixed and random groups coexist with short distinct links and frozen configurations', async () => {
      const agents = (await control.getAgentControl(study.id)).agents;
      originalSnapshot = await settingsLib.getExperimentSettings(study.id,false);
      groups = await Promise.all([
        control.activateExperimentRun({ experimentId:study.id,name:'A组',assignmentMode:'fixed',fixedAgentId:agents[0].id,randomAgentIds:[],makeDefault:false },adminId),
        control.activateExperimentRun({ experimentId:study.id,name:'B组',assignmentMode:'fixed',fixedAgentId:agents[1].id,randomAgentIds:[],makeDefault:false },adminId),
        control.activateExperimentRun({ experimentId:study.id,name:'随机组',assignmentMode:'balanced_random',fixedAgentId:null,randomAgentIds:agents.map(a => a.id),makeDefault:false },adminId),
      ]);
      assert.equal(new Set(groups.map(group => group.entryToken)).size,3);
      for (const group of groups) {
        assert.match(group.entryToken,/^[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);
        assert.equal(group.isDefault,false);
        const entry = await entries.getExperimentEntry(group.entryToken.toUpperCase().replace('-',''));
        assert.equal(entry.runId,group.id);
        assert.equal(entry.experimentId,study.id);
      }
      const current = await control.getAgentControl(study.id);
      assert.equal(current.runs.filter(run => run.status === 'active').length,3);
      assert.equal(current.activeRun,null);
      const legacyToken = (await pool.query('SELECT entry_token FROM experiment_runs WHERE id=$1',[runId])).rows[0].entry_token;
      assert.equal((await entries.getExperimentEntry(legacyToken)).runId,runId);
      await pool.query(`UPDATE experiment_runs SET metadata=metadata || '{"entry_token_aliases":["abcd-2345"]}'::jsonb WHERE id=$1`,[runId]);
      const alias = await entries.getExperimentEntry('ABCD2345');
      assert.equal(alias.runId,runId);
      assert.equal(alias.token,legacyToken);
      for (let i=0;i<groups.length;i++) for (let j=i+1;j<groups.length;j++) {
        const a = groups[i].entryToken.replace('-',''), b = groups[j].entryToken.replace('-','');
        assert.ok([...a].filter((char,index) => char !== b[index]).length >= 2);
      }
      await settingsLib.saveExperimentSettings({ ...originalSnapshot, experiment:{ ...originalSnapshot.experiment,title:'后续修改的任务' },ai:{ baseUrl:originalSnapshot.ai.baseUrl,botId:originalSnapshot.ai.botId } },adminId);
    });
    const scopedRequest = (group,body,path='/api/sessions') => h.request(body,`http://localhost${path}?entry=${group.entryToken}`);
    let linkedA, linkedB, linkedOther, participantA, participantB, otherGroup;
    await t.test('entry validation and required student numbers cannot create empty or misplaced records', async () => {
      const before = (await pool.query('SELECT count(*)::int AS n FROM participants')).rows[0].n;
      for (const token of ['missing','abcdefgh','ffffffffffffffffffffffffffffffff']) {
        assert.equal((await sessions.POST(h.request({ profile:{ fullName:'错误',studentNumber:'bad' } },`http://localhost/api/sessions?entry=${token}`))).status,404);
      }
      assert.equal((await sessions.POST(scopedRequest(groups[0],{ profile:{ fullName:'同名',studentNumber:'  ' } }))).status,400);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants')).rows[0].n,before);
    });
    await t.test('links isolate cookies, codes, same-name identities and assigned agents across groups and experiments', async () => {
      linkedA = await sessions.POST(scopedRequest(groups[0],{ profile:{ fullName:'  同名  ',studentNumber:'  link-001  ' } }));
      assert.equal(linkedA.status,201);
      assert.equal(linkedA.body.session.participantCode,'P001');
      assert.equal(linkedA.body.participantProfile.fullName,'同名');
      assert.equal(linkedA.body.participantProfile.studentNumber,'link-001');
      assert.equal(linkedA.body.experiment.title,originalSnapshot.experiment.title);
      assert.equal(linkedA.body.session.agentId,groups[0].fixedAgentId);
      assert.equal((await sessions.GET(scopedRequest(groups[1],{}))).status,401);
      linkedB = await sessions.POST(scopedRequest(groups[1],{ profile:{ fullName:'同名',studentNumber:'link-002' } }));
      assert.equal(linkedB.status,201);
      assert.equal(linkedB.body.session.participantCode,'P002');
      assert.equal(linkedB.body.session.agentId,groups[1].fixedAgentId);
      assert.equal((await sessions.GET(scopedRequest(groups[0],{}))).body.session.id,linkedA.body.session.id);
      const agents = (await control.getAgentControl(otherStudy.id)).agents;
      otherGroup = await control.activateExperimentRun({ experimentId:otherStudy.id,name:'另一实验A组',assignmentMode:'fixed',fixedAgentId:agents[0].id,randomAgentIds:[],makeDefault:false },adminId);
      linkedOther = await sessions.POST(scopedRequest(otherGroup,{ profile:{ fullName:'同名',studentNumber:'link-001' } }));
      assert.equal(linkedOther.status,201);
      assert.equal(linkedOther.body.session.participantCode,'P001');
      assert.notEqual(linkedOther.body.session.id,linkedA.body.session.id);
      participantA = (await auth.getAuthenticatedSession(await entries.getExperimentEntry(groups[0].entryToken))).participantId;
      participantB = (await auth.getAuthenticatedSession(await entries.getExperimentEntry(groups[1].entryToken))).participantId;
      const cookieA = h.jar.get(entries.sessionCookieName(await entries.getExperimentEntry(groups[0].entryToken)));
      const cookieBName = entries.sessionCookieName(await entries.getExperimentEntry(groups[1].entryToken));
      const savedB = h.jar.get(cookieBName);
      h.jar.set(cookieBName,cookieA);
      assert.equal((await sessions.GET(scopedRequest(groups[1],{}))).status,401);
      h.jar.set(cookieBName,savedB);
      h.jar.set('edulab_session',cookieA);
      assert.equal((await sessions.GET()).status,401);
    });
    let linkedContext;
    await t.test('scoped message, draft and conversation APIs preserve independent records and reject cross-group switches', async () => {
      const sent = await messages.POST(scopedRequest(groups[0],{ clientRequestId:crypto.randomUUID(),content:'A组原始关键词' },'/api/messages'));
      assert.equal(sent.status,200);
      linkedContext = h.creates.at(-1).conversation_id ?? (await sessions.GET(scopedRequest(groups[0],{}))).body.session.cozeConversationId;
      assert.equal(h.creates.at(-1).bot_id,(await auth.getAuthenticatedSession(await entries.getExperimentEntry(groups[0].entryToken))).configSnapshot.ai.botId);
      assert.equal((await draft.PUT(scopedRequest(groups[0],{ sessionId:linkedA.body.session.id,text:'A组草稿',revision:(await sessions.GET(scopedRequest(groups[0],{}))).body.draft.revision },'/api/sessions/draft'))).status,200);
      assert.equal((await sessions.GET(scopedRequest(groups[1],{}))).body.messages.length,0);
      assert.equal((await sessions.GET(scopedRequest(otherGroup,{}))).body.messages.length,0);
      const conversation = h.load('app/api/conversations/route.ts');
      assert.equal((await conversation.POST(scopedRequest(groups[1],{ action:'switch',sessionId:linkedA.body.session.id },'/api/conversations'))).status,404);
      const created = await conversation.POST(scopedRequest(groups[0],{ action:'create' },'/api/conversations'));
      assert.equal(created.status,200);
      assert.equal(created.body.payload.session.experimentRunId,groups[0].id);
      assert.equal((await conversation.POST(scopedRequest(groups[0],{ action:'switch',sessionId:linkedA.body.session.id },'/api/conversations'))).status,200);
      assert.equal((await conversation.GET(scopedRequest(groups[0],{},'/api/conversations'))).body.conversations.length,2);
      assert.equal((await conversation.GET(scopedRequest(groups[1],{},'/api/conversations'))).body.conversations.length,1);
    });
    await t.test('recovery cannot switch group; stopped enrollment keeps original AI context and completed state', async () => {
      const closed = await control.closeActiveExperimentRun(study.id,adminId,groups[0].id);
      assert.equal(closed.entryToken,groups[0].entryToken);
      assert.equal((await control.getAgentControl(study.id)).runs.filter(run => run.status === 'active').length,2);
      h.jar.clear();
      assert.equal((await sessions.POST(scopedRequest(groups[0],{ profile:{ fullName:'新学生',studentNumber:'new-student' } }))).status,409);
      assert.equal((await resume.POST(scopedRequest(groups[1],{ participantCode:'P001',identity:'link-001' },'/api/sessions/resume'))).status,404);
      assert.equal((await resume.POST(scopedRequest(groups[0],{ participantCode:' p001 ',identity:' link-001 ' },'/api/sessions/resume'))).status,200);
      const restored = (await sessions.GET(scopedRequest(groups[0],{}))).body;
      assert.equal(restored.session.id,linkedA.body.session.id);
      assert.equal(restored.session.agentId,groups[0].fixedAgentId);
      assert.equal(restored.draft.text,'A组草稿');
      assert.equal(restored.messages.length,2);
      assert.equal((await messages.POST(scopedRequest(groups[0],{ clientRequestId:crypto.randomUUID(),content:'接着之前的话题' },'/api/messages'))).status,200);
      assert.equal(h.creates.at(-1).conversation_id,linkedContext);
      assert.equal((await complete.POST(scopedRequest(groups[0],{ messages:[],storedMessageCount:4 },'/api/sessions/complete'))).status,200);
      h.jar.clear();
      assert.equal((await resume.POST(scopedRequest(groups[0],{ participantCode:'P001',identity:'link-001' },'/api/sessions/resume'))).status,200);
      assert.equal((await sessions.GET(scopedRequest(groups[0],{}))).body.session.status,'completed');
      assert.equal((await sessions.POST(scopedRequest(groups[0],{ profile:{ fullName:'同名',studentNumber:'link-001' } }))).body.session.status,'completed');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants WHERE experiment_id=$1',[study.id])).rows[0].n,2);
    });
    await t.test('admin directory and exports filter by experiment/group and never mix matching participant codes', async () => {
      asAdmin();
      const directory = h.load('app/api/admin/participants/route.ts');
      const req = (exp,run) => h.request({},`http://localhost/api/admin/participants?experimentId=${exp}${run ? '&runId='+run : ''}`);
      const a = await directory.GET(req(study.id,groups[0].id));
      assert.equal(a.status,200);
      assert.equal(a.body.participants.length,1);
      assert.equal(a.body.participants[0].id,participantA);
      assert.equal(a.body.participants[0].sessionCount,2);
      assert.equal((await directory.GET(req(study.id,otherGroup.id))).status,404);
      const exp = h.load('lib/admin-export.ts');
      const archive = await exp.buildInteractionArchive({ experimentId:study.id,runId:groups[0].id,participantIds:[participantA],adminUserId:adminId });
      const unzipped = fflate.unzipSync(archive.bytes);
      const manifest = JSON.parse(fflate.strFromU8(unzipped['manifest.json']));
      assert.equal(manifest.experimentId,study.id);
      assert.equal(manifest.experimentRunId,groups[0].id);
      assert.equal(manifest.messageCount,4);
      assert.equal(manifest.participantCount,1);
      const data = Object.entries(unzipped).filter(([name]) => name !== 'manifest.json').map(([,bytes]) => JSON.parse(fflate.strFromU8(bytes)));
      assert.ok(data.every(record => record.session.experimentRunId === groups[0].id));
      assert.equal(JSON.stringify(data).includes('link-001'),false);
      await assert.rejects(() => exp.buildInteractionArchive({ experimentId:study.id,runId:groups[1].id,participantIds:[participantA],adminUserId:adminId }),/PARTICIPANTS_NOT_FOUND/);
      await assert.rejects(() => exp.buildIdentityMappingCsv({ experimentId:otherStudy.id,participantIds:[participantB],adminUserId:adminId }),/PARTICIPANTS_NOT_FOUND/);
      const csv = await exp.buildIdentityMappingCsv({ experimentId:study.id,runId:groups[0].id,participantIds:[participantA],adminUserId:adminId });
      assert.ok(csv.content.includes('link-001'));
      assert.equal(csv.content.includes('link-002'),false);
    });
    const lifecycleApi = h.load('app/api/admin/agent-control/route.ts');
    const adminRequest = (body,experimentId=study.id) => h.request(body,`http://localhost/api/admin/agent-control?experimentId=${experimentId}`);
    await t.test('reopening requires admin, preserves the same link, snapshot and completed sessions', async () => {
      h.jar.delete('edulab_admin');
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'reopen_run',runId:groups[0].id }))).status,401);
      asAdmin();
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'reopen_run',runId:groups[0].id },otherStudy.id))).status,404);
      const before = (await pool.query('SELECT config_snapshot,opened_at FROM experiment_runs WHERE id=$1',[groups[0].id])).rows[0];
      const sessionsBefore = (await pool.query('SELECT * FROM experiment_sessions WHERE experiment_run_id=$1 ORDER BY id',[groups[0].id])).rows;
      const response = await lifecycleApi.POST(adminRequest({ action:'reopen_run',runId:groups[0].id }));
      assert.equal(response.status,200);
      const run = response.body.control.runs.find(run => run.id === groups[0].id);
      assert.equal(run.status,'active');
      assert.equal(run.entryToken,groups[0].entryToken);
      assert.equal(run.closedAt,null);
      assert.deepEqual((await pool.query('SELECT config_snapshot,opened_at FROM experiment_runs WHERE id=$1',[run.id])).rows[0],before);
      assert.deepEqual((await pool.query('SELECT * FROM experiment_sessions WHERE experiment_run_id=$1 ORDER BY id',[run.id])).rows,sessionsBefore);
      assert.equal((await sessions.GET(scopedRequest(groups[0],{}))).body.session.status,'completed');
    });
    await t.test('simultaneous signups across fixed and balanced groups share one experiment-wide numbering sequence', async () => {
      const browsers = await Promise.all(Array.from({ length:12 },() => harness(db,h.sources)));
      const results = await Promise.all(browsers.map((browser,index) => {
        const group = groups[index%3];
        return browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'并发学生',studentNumber:`parallel-${index}` } },`http://localhost/api/sessions?entry=${group.entryToken}`));
      }));
      assert.ok(results.every(response => response.status === 201));
      const codes = results.map(response => response.body.session.participantCode);
      assert.equal(new Set(codes).size,12);
      assert.deepEqual(codes.sort(),Array.from({ length:12 },(_,index) => `P${String(index+3).padStart(3,'0')}`));
      results.forEach((response,index) => {
        assert.equal(response.body.session.experimentRunId,groups[index%3].id);
        if (index%3 !== 2) assert.equal(response.body.session.agentId,groups[index%3].fixedAgentId);
      });
      const counts = (await pool.query('SELECT count(*)::int AS n FROM participant_agent_assignments WHERE experiment_run_id=$1 GROUP BY agent_id',[groups[2].id])).rows;
      assert.deepEqual(counts.map(row => row.n).sort(),[2,2]);
      await assert.rejects(() => pool.query('INSERT INTO participants (id,experiment_id,external_code) VALUES ($1,$2,$3)',[crypto.randomUUID(),study.id,'P001']),error => error.code === '23505');
    });
    let staleB;
    await t.test('link deletion rejects active enrollment, wrong confirmation and in-flight AI without changing records', async () => {
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'delete_run_link',runId:groups[1].id,confirmationCode:groups[1].entryToken }))).status,409);
      assert.equal((await resume.POST(scopedRequest(groups[1],{ participantCode:'P002',identity:'link-002' },'/api/sessions/resume'))).status,200);
      h.setPending(true);
      assert.equal((await messages.POST(scopedRequest(groups[1],{ clientRequestId:crypto.randomUUID(),content:'等待中的回复' },'/api/messages'))).status,202);
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'close_active_run',runId:groups[1].id }))).status,200);
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'delete_run_link',runId:groups[1].id,confirmationCode:'wrong' }))).status,400);
      const before = (await pool.query('SELECT * FROM experiment_sessions WHERE experiment_run_id=$1 ORDER BY id',[groups[1].id])).rows;
      const rejected = await lifecycleApi.POST(adminRequest({ action:'delete_run_link',runId:groups[1].id,confirmationCode:groups[1].entryToken }));
      assert.equal(rejected.status,409);
      assert.equal(rejected.body.error.code,'RUN_BUSY');
      assert.deepEqual((await pool.query('SELECT * FROM experiment_sessions WHERE experiment_run_id=$1 ORDER BY id',[groups[1].id])).rows,before);
      assert.equal((await entries.getExperimentEntry(groups[1].entryToken)).runId,groups[1].id);
      h.setPending(false);
      assert.equal((await sessions.GET(scopedRequest(groups[1],{}))).body.messages.length,2);
      staleB = await auth.getAuthenticatedSession(await entries.getExperimentEntry(groups[1].entryToken));
    });
    await t.test('continue enrollment validates original agents, is idempotent and does not restart numbering', async () => {
      await pool.query('UPDATE ai_agent_configs SET enabled=false WHERE id=$1',[groups[1].fixedAgentId]);
      const rejected = await lifecycleApi.POST(adminRequest({ action:'reopen_run',runId:groups[1].id }));
      assert.equal(rejected.status,409);
      assert.equal(rejected.body.error.code,'RUN_AGENT_UNAVAILABLE');
      await pool.query('UPDATE ai_agent_configs SET enabled=true WHERE id=$1',[groups[1].fixedAgentId]);
      const before = (await pool.query('SELECT config_snapshot,opened_at FROM experiment_runs WHERE id=$1',[groups[1].id])).rows[0];
      for (let i=0;i<2;i++) assert.equal((await lifecycleApi.POST(adminRequest({ action:'reopen_run',runId:groups[1].id }))).status,200);
      assert.deepEqual((await pool.query('SELECT config_snapshot,opened_at FROM experiment_runs WHERE id=$1',[groups[1].id])).rows[0],before);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM admin_audit_log WHERE action='experiment.run.reopen' AND after_data->>'id'=$1",[groups[1].id])).rows[0].n,1);
      const browser = await harness(db,h.sources);
      const created = await browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'继续报名的学生',studentNumber:'parallel-continue' } },`http://localhost/api/sessions?entry=${groups[1].entryToken}`));
      assert.equal(created.status,201);
      assert.equal(created.body.session.participantCode,'P015');
      assert.equal(created.body.session.agentId,groups[1].fixedAgentId);
    });
    await t.test('deleting a finished link reserves its code, retains research data and revokes stale writes', async () => {
      const revision = (await sessions.GET(scopedRequest(groups[1],{}))).body.draft.revision;
      assert.equal((await draft.PUT(scopedRequest(groups[1],{ sessionId:linkedB.body.session.id,text:'保留的草稿',revision },'/api/sessions/draft'))).status,200);
      assert.equal((await complete.POST(scopedRequest(groups[1],{ messages:[],storedMessageCount:2 },'/api/sessions/complete'))).status,200);
      await pool.query(`UPDATE experiment_runs SET metadata=metadata || '{"entry_token_aliases":["qrst-2345"]}'::jsonb WHERE id=$1`,[groups[1].id]);
      const preserved = async () => ({
        participants:(await pool.query('SELECT * FROM participants WHERE experiment_id=$1 ORDER BY id',[study.id])).rows,
        assignments:(await pool.query('SELECT * FROM participant_agent_assignments WHERE experiment_run_id=$1 ORDER BY id',[groups[1].id])).rows,
        messages:(await pool.query('SELECT m.* FROM messages m JOIN experiment_sessions s ON s.id=m.session_id WHERE s.experiment_run_id=$1 ORDER BY m.id',[groups[1].id])).rows,
        requests:(await pool.query('SELECT r.* FROM chat_requests r JOIN experiment_sessions s ON s.id=r.session_id WHERE s.experiment_run_id=$1 ORDER BY r.id',[groups[1].id])).rows,
        sessions:(await pool.query('SELECT * FROM experiment_sessions WHERE experiment_run_id=$1 ORDER BY id',[groups[1].id])).rows,
        snapshot:(await pool.query('SELECT config_snapshot,fixed_agent_id,random_agent_ids FROM experiment_runs WHERE id=$1',[groups[1].id])).rows,
      });
      const before = await preserved();
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'close_active_run',runId:groups[1].id }))).status,200);
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'delete_run_link',runId:groups[1].id,confirmationCode:groups[1].entryToken },otherStudy.id))).status,404);
      failLinkDeleteAudit = true;
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'delete_run_link',runId:groups[1].id,confirmationCode:groups[1].entryToken }))).status,500);
      failLinkDeleteAudit = false;
      assert.deepEqual(await preserved(),before);
      assert.equal((await entries.getExperimentEntry(groups[1].entryToken)).runId,groups[1].id);
      const response = await lifecycleApi.POST(adminRequest({ action:'delete_run_link',runId:groups[1].id,confirmationCode:groups[1].entryToken.toUpperCase() }));
      assert.equal(response.status,200);
      const deleted = response.body.control.runs.find(run => run.id === groups[1].id);
      assert.equal(deleted.entryToken,null);
      assert.equal(deleted.entryCodeReserved,true);
      assert.ok(deleted.entryDeletedAt);
      assert.equal(deleted.status,'closed');
      const after = await preserved();
      for (const key of ['participants','assignments','messages','requests','snapshot']) assert.deepEqual(after[key],before[key]);
      const content = session => Object.fromEntries(Object.entries(session).filter(([key]) => !["status","completed_at","session_secret_hash","metadata"].includes(key)));
      assert.deepEqual(after.sessions.map(content),before.sessions.map(content));
      assert.ok(after.sessions.every(session => session.status === 'completed' && session.completed_at));
      for (const session of before.sessions.filter(session => session.status === 'completed')) assert.equal(after.sessions.find(row => row.id === session.id).completed_at.getTime(),session.completed_at.getTime());
      assert.equal((await sessions.GET(scopedRequest(groups[1],{}))).status,404);
      await assert.rejects(() => entries.getExperimentEntry('qrst2345'),error => error.code === 'ENTRY_NOT_FOUND');
      assert.equal((await lifecycleApi.POST(adminRequest({ action:'reopen_run',runId:groups[1].id }))).status,409);
      await assert.rejects(() => h.load('lib/session-write.ts').sessionTransaction(staleB,async () => {}),error => error.code === 'SESSION_REPLACED');
      const directory = await h.load('app/api/admin/participants/route.ts').GET(h.request({},`http://localhost/api/admin/participants?experimentId=${study.id}&runId=${groups[1].id}`));
      assert.equal(directory.status,200);
      assert.equal(directory.body.participants.length,6);
      const archive = await h.load('lib/admin-export.ts').buildInteractionArchive({ experimentId:study.id,runId:groups[1].id,participantIds:[participantB],adminUserId:adminId });
      assert.equal(JSON.parse(fflate.strFromU8(fflate.unzipSync(archive.bytes)['manifest.json'])).messageCount,2);
      const audit = (await pool.query("SELECT before_data,after_data FROM admin_audit_log WHERE action='experiment.run.link.delete' AND before_data->>'id'=$1",[groups[1].id])).rows[0];
      assert.equal(audit.before_data.entryToken,groups[1].entryToken);
      assert.deepEqual(audit.before_data.entryTokenAliases,['qrst-2345']);
      assert.equal(audit.after_data.preservedSessionCount,6);
      assert.equal(audit.after_data.entryCodeReserved,true);
      const metadata = (await pool.query('SELECT metadata FROM experiment_runs WHERE id=$1',[groups[1].id])).rows[0].metadata;
      assert.equal(metadata.retired_entry_token,groups[1].entryToken);
      assert.equal(metadata.entry_code_reserved,true);
    });
    await t.test('a used retired code cannot be allocated again and original participants remain isolated', async () => {
      h.forceToken(groups[1].entryToken);
      const replacement = await control.activateExperimentRun({ experimentId:study.id,name:'新的实验入口',assignmentMode:'fixed',fixedAgentId:groups[0].fixedAgentId,randomAgentIds:[],makeDefault:false },adminId);
      assert.notEqual(replacement.entryToken,groups[1].entryToken);
      assert.ok([...replacement.entryToken].filter((char,index) => char !== groups[1].entryToken[index]).length >= 2);
      await assert.rejects(() => entries.getExperimentEntry(groups[1].entryToken),error => error.code === 'ENTRY_NOT_FOUND');
      assert.notEqual(replacement.id,groups[1].id);
      assert.equal((await sessions.GET(scopedRequest(replacement,{}))).status,401);
      assert.equal((await resume.POST(scopedRequest(replacement,{ participantCode:'P002',identity:'link-002' },'/api/sessions/resume'))).status,404);
      const browser = await harness(db,h.sources);
      const created = await browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'新入口学生',studentNumber:'parallel-reuse' } },`http://localhost/api/sessions?entry=${replacement.entryToken}`));
      assert.equal(created.status,201);
      assert.equal(created.body.session.participantCode,'P016');
      assert.equal(created.body.session.experimentRunId,replacement.id);
      assert.equal(created.body.session.agentId,groups[0].fixedAgentId);
      const counts = (await pool.query('SELECT count(*)::int AS total,count(DISTINCT external_code)::int AS distinct_codes FROM participants WHERE experiment_id=$1',[study.id])).rows[0];
      assert.deepEqual(counts,{ total:16,distinct_codes:16 });
    });
    const agentInput = (agent,overrides={}) => ({ id:agent.id,internalName:agent.internalName,provider:agent.provider,
      baseUrl:agent.baseUrl,botId:agent.botId,enabled:agent.enabled,...overrides });
    const newAgent = (label) => control.saveAgentConfig({ experimentId:otherStudy.id,internalName:label,
      baseUrl:'https://api.coze.com',botId:crypto.randomUUID(),enabled:true },adminId);
    const newFixedRun = (agent,label) => control.activateExperimentRun({ experimentId:otherStudy.id,
      name:label,assignmentMode:'fixed',fixedAgentId:agent.id,randomAgentIds:[],makeDefault:false },adminId);
    const deleteEmptyLink = async run => {
      await control.closeActiveExperimentRun(otherStudy.id,adminId,run.id);
      await control.deleteExperimentRunLink({ experimentId:otherStudy.id,runId:run.id,confirmationCode:run.entryToken },adminId);
    };
    await t.test('enrolled configs stay frozen after all enrollment stops and after link deletion', async () => {
      for (const group of groups) await control.closeActiveExperimentRun(study.id,adminId,group.id);
      const before = (await pool.query('SELECT * FROM ai_agent_configs WHERE experiment_id=$1 ORDER BY id',[study.id])).rows;
      for (const agent of (await control.getAgentControl(study.id)).agents) {
        assert.equal(agent.hasExperimentRecords,true);
        for (const overrides of [{ botId:'changed-bot' },{ internalName:'changed-name' },
          { baseUrl:'https://api.coze.cn' },{ provider:'dify',token:'changed-token' },{ enabled:false },
          { botId:'changed-with-key',token:'changed-token' }]) {
          const result = await lifecycleApi.POST(adminRequest({ action:'save_agent',agent:agentInput(agent,overrides) }));
          assert.equal(result.status,409);
          assert.equal(result.body.error.code,'AGENT_RECORDS_LOCKED');
        }
      }
      assert.deepEqual((await pool.query('SELECT * FROM ai_agent_configs WHERE experiment_id=$1 ORDER BY id',[study.id])).rows,before);
      // Reopening admits new students to precisely the same configuration.
      await control.reopenExperimentRun(study.id,groups[0].id,adminId);
      const browser = await harness(db,h.sources);
      const created = await browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'',studentNumber:'after-frozen-pause' } },`http://localhost/api/sessions?entry=${groups[0].entryToken}`));
      assert.equal(created.status,201);
      assert.equal(created.body.session.agentId,groups[0].fixedAgentId);
      await browser.load('app/api/messages/route.ts').POST(browser.request({ clientRequestId:crypto.randomUUID(),content:'保持原智能体' },`http://localhost/api/messages?entry=${groups[0].entryToken}`));
      assert.equal(browser.creates.at(-1).bot_id,before.find(agent => agent.id===groups[0].fixedAgentId).coze_bot_id);
    });
    await t.test('the first enrollment freezes every random-group candidate even before any chat message', async () => {
      const agents = await Promise.all([newAgent('随机锁定A'),newAgent('随机锁定B')]);
      const run = await control.activateExperimentRun({ experimentId:otherStudy.id,name:'首次报名即锁定',
        assignmentMode:'balanced_random',fixedAgentId:null,randomAgentIds:agents.map(agent => agent.id),makeDefault:false },adminId);
      const browser = await harness(db,h.sources);
      const created = await browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'',studentNumber:'freeze-before-chat' } },`http://localhost/api/sessions?entry=${run.entryToken}`));
      assert.equal(created.status,201);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages m JOIN experiment_sessions s ON s.id=m.session_id WHERE s.experiment_run_id=$1',[run.id])).rows[0].n,0);
      await control.closeActiveExperimentRun(otherStudy.id,adminId,run.id);
      for (const agent of agents) {
        await assert.rejects(() => control.saveAgentConfig({ experimentId:otherStudy.id,...agentInput(agent,{ botId:'changed-random-bot' }) },adminId),/AGENT_RECORDS_LOCKED/);
        assert.equal((await control.getAgentControl(otherStudy.id)).agents.find(a => a.id===agent.id).hasExperimentRecords,true);
      }
      await control.deleteExperimentRunLink({ experimentId:otherStudy.id,runId:run.id,confirmationCode:run.entryToken },adminId);
      for (const agent of agents) await assert.rejects(() => control.saveAgentConfig({ experimentId:otherStudy.id,...agentInput(agent,{ enabled:false }) },adminId),/AGENT_RECORDS_LOCKED/);
    });
    await t.test('a paused empty config remains editable and only a verified unused empty code can be reused', async () => {
      const original = await newAgent('未使用的配置'), replacementAgent = await newAgent('空入口替代配置');
      const empty = await newFixedRun(original,'空白可释放入口');
      await assert.rejects(() => control.saveAgentConfig({ experimentId:otherStudy.id,...agentInput(original,{ botId:'unused-edited' }) },adminId),/ACTIVE_AGENT_LOCKED/);
      await control.closeActiveExperimentRun(otherStudy.id,adminId,empty.id);
      await control.saveAgentConfig({ experimentId:otherStudy.id,...agentInput(original,{ botId:'unused-edited' }) },adminId);
      await control.deleteExperimentRunLink({ experimentId:otherStudy.id,runId:empty.id,confirmationCode:empty.entryToken },adminId);
      const audit = (await pool.query("SELECT after_data FROM admin_audit_log WHERE action='experiment.run.link.delete' AND before_data->>'id'=$1",[empty.id])).rows[0];
      assert.equal(audit.after_data.entryCodeReserved,false);
      // Fresh codes are preferred; exhaust those draws to exercise safe fallback.
      for (let i=0;i<101;i++) h.forceToken(empty.entryToken);
      const replacement = await newFixedRun(replacementAgent,'无记录旧码复用');
      assert.equal(replacement.entryToken,empty.entryToken);
      assert.equal((await entries.getExperimentEntry(empty.entryToken)).runId,replacement.id);
    });
    await t.test('empty links cannot release codes for agents still referenced by another live or paused entry', async () => {
      const agent = await newAgent('仍使用的空配置');
      const first = await newFixedRun(agent,'仍开放的空入口'), second = await newFixedRun(agent,'删除的空入口');
      await deleteEmptyLink(second);
      const metadata = (await pool.query('SELECT metadata FROM experiment_runs WHERE id=$1',[second.id])).rows[0].metadata;
      assert.equal(metadata.entry_code_reserved,true);
      await control.closeActiveExperimentRun(otherStudy.id,adminId,first.id);
      h.forceToken(second.entryToken);
      const replacement = await newFixedRun(await newAgent('其他空配置'),'已保留码拒绝复用');
      assert.notEqual(replacement.entryToken,second.entryToken);
      await assert.rejects(() => entries.getExperimentEntry(second.entryToken),error => error.code==='ENTRY_NOT_FOUND');
    });
    await t.test('an empty link for an agent with records elsewhere reserves its code', async () => {
      const agent = (await control.getAgentControl(study.id)).agents[0];
      const run = await control.activateExperimentRun({ experimentId:study.id,name:'有记录配置的空入口',assignmentMode:'fixed',fixedAgentId:agent.id,randomAgentIds:[],makeDefault:false },adminId);
      await control.closeActiveExperimentRun(study.id,adminId,run.id);
      await control.deleteExperimentRunLink({ experimentId:study.id,runId:run.id,confirmationCode:run.entryToken },adminId);
      assert.equal((await pool.query('SELECT metadata FROM experiment_runs WHERE id=$1',[run.id])).rows[0].metadata.entry_code_reserved,true);
      h.forceToken(run.entryToken);
      const replacement = await newFixedRun(await newAgent('跨记录保护配置'),'有记录旧码拒绝');
      assert.notEqual(replacement.entryToken,run.entryToken);
    });
    await t.test('released empty codes are rechecked if their original agent becomes used before reuse', async () => {
      const agent = await newAgent('释放后再次使用的配置');
      const empty = await newFixedRun(agent,'先删除的空入口');
      await deleteEmptyLink(empty);
      assert.equal((await pool.query('SELECT metadata FROM experiment_runs WHERE id=$1',[empty.id])).rows[0].metadata.entry_code_reserved,false);
      const active = await newFixedRun(agent,'原配置重新使用');
      h.forceToken(empty.entryToken);
      const next = await newFixedRun(await newAgent('另一个新配置'),'重新使用后不复用旧码');
      assert.notEqual(next.entryToken,empty.entryToken);
      const browser = await harness(db,h.sources);
      assert.equal((await browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'',studentNumber:'released-agent-now-used' } },`http://localhost/api/sessions?entry=${active.entryToken}`))).status,201);
      await deleteEmptyLink(active);
      h.forceToken(empty.entryToken);
      assert.notEqual((await newFixedRun(await newAgent('历史记录保护配置'),'有记录后拒绝旧码')).entryToken,empty.entryToken);
    });
    await t.test('historical deletions without a reuse decision remain reserved, and already reused unsafe URLs fail closed', async () => {
      const audit = (await pool.query("SELECT id,after_data FROM admin_audit_log WHERE action='experiment.run.link.delete' AND before_data->>'id'=$1",[groups[1].id])).rows[0];
      const metadata = (await pool.query('SELECT metadata FROM experiment_runs WHERE id=$1',[groups[1].id])).rows[0].metadata;
      await pool.query("UPDATE admin_audit_log SET after_data=after_data-'entryCodeReserved' WHERE id=$1",[audit.id]);
      await pool.query("UPDATE experiment_runs SET metadata=metadata-'entry_code_reserved'-'retired_entry_token' WHERE id=$1",[groups[1].id]);
      try {
        h.forceToken(groups[1].entryToken);
        const run = await newFixedRun(await newAgent('历史冲突检验配置'),'历史旧码拒绝');
        assert.notEqual(run.entryToken,groups[1].entryToken);
        await pool.query('UPDATE experiment_runs SET entry_token=$2 WHERE id=$1',[run.id,groups[1].entryToken]);
        await assert.rejects(() => entries.getExperimentEntry(groups[1].entryToken),error => error.code==='ENTRY_NOT_FOUND');
        await pool.query('UPDATE experiment_runs SET entry_token=$2 WHERE id=$1',[run.id,run.entryToken]);
        assert.equal((await entries.getExperimentEntry(run.entryToken)).runId,run.id);
      } finally {
        await pool.query('UPDATE admin_audit_log SET after_data=$2::jsonb WHERE id=$1',[audit.id,JSON.stringify(audit.after_data)]);
        await pool.query('UPDATE experiment_runs SET metadata=$2::jsonb WHERE id=$1',[groups[1].id,JSON.stringify(metadata)]);
      }
    });
    await t.test('unused released codes are avoided when a fresh code is available', async () => {
      const empty = await newFixedRun(await newAgent('优先新码的旧配置'),'已删除空入口');
      await deleteEmptyLink(empty);
      h.forceToken(empty.entryToken);
      const fresh = await newFixedRun(await newAgent('优先新码的新配置'),'优先新码');
      assert.notEqual(fresh.entryToken,empty.entryToken);
    });
    await t.test('snapshot-only historical associations still lock editing and deletion', async () => {
      const agent = await newAgent('仅快照关联的配置'), run = await newFixedRun(agent,'历史快照入口');
      const browser = await harness(db,h.sources);
      const created = await browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'',studentNumber:'snapshot-only' } },`http://localhost/api/sessions?entry=${run.entryToken}`));
      assert.equal(created.status,201);
      await control.closeActiveExperimentRun(otherStudy.id,adminId,run.id);
      // Simulate older records whose relationship exists only in the snapshot.
      await pool.query('DELETE FROM participant_agent_assignments WHERE experiment_run_id=$1',[run.id]);
      await pool.query('UPDATE experiment_sessions SET agent_id=NULL,experiment_run_id=NULL WHERE experiment_run_id=$1',[run.id]);
      const summary = (await control.getAgentControl(otherStudy.id)).agents.find(a => a.id===agent.id);
      assert.equal(summary.hasExperimentRecords,true);
      assert.equal(summary.hasReferences,true);
      await assert.rejects(() => control.saveAgentConfig({ experimentId:otherStudy.id,...agentInput(agent,{ botId:'changed-legacy' }) },adminId),/AGENT_RECORDS_LOCKED/);
      await assert.rejects(() => control.deleteAgentConfig({ experimentId:otherStudy.id,agentId:agent.id,confirmationName:agent.internalName },adminId),/AGENT_HAS_REFERENCES/);
    });
    await t.test('simultaneous first enrollment, pause and config edits cannot change an enrolled bot', async () => {
      for (let attempt=0;attempt<3;attempt++) {
        const agent = await newAgent(`报名并发配置${attempt}`), run = await newFixedRun(agent,`报名并发入口${attempt}`);
        const browser = await harness(db,h.sources);
        const [signup,edit,paused] = await Promise.all([
          browser.load('app/api/sessions/route.ts').POST(browser.request({ profile:{ fullName:'',studentNumber:`concurrent-freeze-${attempt}` } },`http://localhost/api/sessions?entry=${run.entryToken}`)),
          lifecycleApi.POST(adminRequest({ action:'save_agent',agent:agentInput(agent,{ botId:`concurrent-edit-${attempt}` }) },otherStudy.id)),
          lifecycleApi.POST(adminRequest({ action:'close_active_run',runId:run.id },otherStudy.id)),
        ]);
        assert.equal(paused.status,200);
        assert.ok([201,409].includes(signup.status));
        assert.ok([200,409].includes(edit.status));
        if (signup.status===201) {
          assert.equal(edit.status,409);
          assert.equal((await pool.query('SELECT coze_bot_id FROM ai_agent_configs WHERE id=$1',[agent.id])).rows[0].coze_bot_id,agent.botId);
          await assert.rejects(() => control.saveAgentConfig({ experimentId:otherStudy.id,...agentInput(agent,{ botId:'after-race-edit' }) },adminId),/AGENT_RECORDS_LOCKED/);
        }
      }
    });
    await t.test('deleting an unused agent cannot release an empty random-link code shared with a used agent', async () => {
      const unused = await newAgent('可删除的空配置');
      const used = (await control.getAgentControl(otherStudy.id)).agents.find(agent => agent.hasExperimentRecords);
      const run = await control.activateExperimentRun({ experimentId:otherStudy.id,name:'清理配置时保护旧码',
        assignmentMode:'balanced_random',fixedAgentId:null,randomAgentIds:[unused.id,used.id],makeDefault:false },adminId);
      await control.closeActiveExperimentRun(otherStudy.id,adminId,run.id);
      await control.deleteAgentConfig({ experimentId:otherStudy.id,agentId:unused.id,confirmationName:unused.internalName },adminId);
      assert.equal((await pool.query('SELECT id FROM experiment_runs WHERE id=$1',[run.id])).rowCount,0);
      const audit = (await pool.query("SELECT before_data FROM admin_audit_log WHERE action='ai.agent.delete' AND before_data->>'id'=$1",[unused.id])).rows[0].before_data;
      assert.equal(audit.removedEmptyRuns[0].entryToken,run.entryToken);
      assert.equal(audit.removedEmptyRuns[0].entryCodeReserved,true);
      h.forceToken(run.entryToken);
      assert.notEqual((await newFixedRun(await newAgent('清理后新配置'),'清理后的新入口')).entryToken,run.entryToken);
      await assert.rejects(() => entries.getExperimentEntry(run.entryToken),error => error.code==='ENTRY_NOT_FOUND');
    });

    await t.test('Dify encrypted app keys, streaming, multi-turn persistence, duplicates and recovery preserve Coze records', async () => {
      asAdmin();
      const experimentId='dify-integration-study';
      await pool.query('INSERT INTO experiments(id,name) VALUES ($1,$2)',[experimentId,'Dify integration']);
      const settings=await settingsLib.getExperimentSettings(study.id,false);
      await settingsLib.saveExperimentSettings({...settings,experiment:{...settings.experiment,id:experimentId},
        limits:{maxUserMessages:null,maxMessageChars:2000,sessionDurationMinutes:null},storage:{databaseMessagesEnabled:true},
        ai:{baseUrl:settings.ai.baseUrl,botId:settings.ai.botId}},adminId);
      const agentApi=h.load('app/api/admin/agent-control/route.ts');
      const adminRequest=body=>h.request(body,`http://localhost/api/admin/agent-control?experimentId=${experimentId}`);
      const secret='app-synthetic-dify-key-1234';
      const saved=await agentApi.POST(adminRequest({action:'save_agent',testAfterSave:true,agent:{internalName:'Dify A',provider:'dify',baseUrl:'https://api.dify.ai/v1',token:secret,enabled:true}}));
      assert.equal(saved.status,200);
      const agent=saved.body.control.agents[0];
      assert.equal(saved.body.test.ok,true);
      assert.equal(agent.provider,'dify'); assert.equal(agent.botId,''); assert.equal(agent.hasToken,true);
      assert.equal(JSON.stringify(saved.body).includes(secret),false);
      const stored=(await pool.query('SELECT * FROM ai_agent_configs WHERE id=$1',[agent.id])).rows[0];
      assert.equal(stored.coze_bot_id,null); assert.notEqual(stored.coze_token_ciphertext,secret);
      assert.equal(h.load('lib/secret-crypto.ts').decryptSecret({ciphertext:stored.coze_token_ciphertext,iv:stored.coze_token_iv,tag:stored.coze_token_tag}),secret);
      assert.equal((await agentApi.POST(adminRequest({action:'save_agent',agent:{internalName:'no key',provider:'dify',baseUrl:'https://api.dify.ai/v1',enabled:true}}))).status,400);
      const secondAgent=await control.saveAgentConfig({experimentId,provider:'dify',internalName:'Dify B',baseUrl:'https://api.dify.ai/v1',botId:'',token:'app-synthetic-dify-key-5678',enabled:true},adminId);
      assert.notEqual(secondAgent.id,agent.id);
      const run=await control.activateExperimentRun({experimentId,name:'Dify group',assignmentMode:'fixed',fixedAgentId:agent.id,randomAgentIds:[],makeDefault:false},adminId);
      const entry=await entries.getExperimentEntry(run.entryToken);
      const req=(body,path='/api/messages')=>scopedRequest(run,body,path);
      const enrolled=await sessions.POST(req({profile:{fullName:'Dify student',studentNumber:'dify-student-001'}},'/api/sessions'));
      assert.equal(enrolled.status,201); assert.equal(enrolled.body.session.participantCode,'P001');
      const active=await auth.getAuthenticatedSession(entry);
      const cozeCreatesBefore=h.creates.length;
      const cozeSessionBefore=(await pool.query('SELECT coze_conversation_id FROM experiment_sessions WHERE id=$1',[sessionId])).rows[0].coze_conversation_id;
      const parse=async response=>{
        assert.match(response.headers.get('content-type'),/text\/event-stream/);
        const events=(await response.text()).split('\n\n').filter(Boolean).map(frame=>JSON.parse(frame.slice(6)));
        const error=events.find(event=>event.event==='error');
        const completed=events.find(event=>event.event==='completed');
        return {events,error,payload:completed?.payload};
      };
      const firstId=crypto.randomUUID();
      const first=await parse(await messages.POST(req({clientRequestId:firstId,content:'记住关键词月亮'})));
      assert.ok(first.events.some(event=>event.event==='delta' && event.answer==='Dify '));
      assert.equal(first.payload.messages.length,2);
      const firstConv=first.payload.session.difyConversationId;
      assert.ok(firstConv); assert.equal(first.payload.session.cozeConversationId,null);
      assert.equal(first.payload.messages[1].provider,'dify'); assert.equal(first.payload.messages[1].cozeMessageId,null);
      assert.equal(first.payload.messages[1].cozeChatId,null); assert.ok(first.payload.messages[1].providerMessageId);
      const calls=h.difyCalls.length;
      const duplicate=await messages.POST(req({clientRequestId:firstId,content:'different duplicate content'}));
      assert.equal(duplicate.status,200); assert.equal(h.difyCalls.length,calls);
      assert.equal(duplicate.body.messages.length,2);
      assert.equal(h.difyCalls.at(-1).authorization,`Bearer ${secret}`);
      const second=await parse(await messages.POST(req({clientRequestId:crypto.randomUUID(),content:'上一轮的关键词是什么？'})));
      assert.equal(second.payload.session.difyConversationId,firstConv);
      assert.equal(h.difyCalls.at(-1).conversation_id,firstConv);
      const user=h.difyCalls.at(-1).user;
      assert.equal(user,h.difyCalls.at(-2).user);
      assert.equal(second.payload.messages.length,4);
      assert.equal(h.creates.length,cozeCreatesBefore);
      assert.equal((await pool.query('SELECT coze_conversation_id FROM experiment_sessions WHERE id=$1',[sessionId])).rows[0].coze_conversation_id,cozeSessionBefore);
      const dbMessages=(await pool.query('SELECT * FROM messages WHERE session_id=$1 ORDER BY sequence_no',[active.id])).rows;
      assert.equal(dbMessages.length,4); assert.equal(dbMessages[1].metadata.provider,'dify');
      assert.equal(JSON.stringify(dbMessages).includes(secret),false);
      const exports=await h.load('lib/admin-export.ts').buildInteractionArchive({experimentId,participantIds:[active.participantId],adminUserId:adminId});
      const archive=fflate.unzipSync(exports.bytes ?? exports.zip ?? exports.data);
      const interaction=JSON.parse(fflate.strFromU8(Object.entries(archive).find(([name])=>name.startsWith('interactions/'))[1]));
      assert.equal(interaction.session.difyConversationId,firstConv); assert.equal(interaction.messages[1].provider,'dify');
      // Corrupt browser content cannot overwrite the authoritative stream reply.
      const copied=second.payload.messages.map(message=>({...message,content:message.role==='assistant'?'伪造内容':message.content}));
      const checkpoint=h.load('app/api/sessions/checkpoint/route.ts');
      assert.equal((await checkpoint.POST(req({sessionId:active.publicId,messages:copied},'/api/sessions/checkpoint'))).status,200);
      assert.match((await sessions.GET(req({},'/api/sessions'))).body.messages[1].content,/Dify 回复/);
      const cookieName=entries.sessionCookieName(entry),oldCookie=h.jar.get(cookieName);
      h.jar.delete(cookieName);
      const restored=await resume.POST(req({participantCode:'P001',identity:'dify-student-001'},'/api/sessions/resume'));
      assert.equal(restored.status,200);
      const resumed=(await sessions.GET(req({},'/api/sessions'))).body;
      assert.equal(resumed.session.difyConversationId,firstConv);
      assert.equal(resumed.messages.length,4); assert.equal(resumed.session.agentId,agent.id);
      const newCookie=h.jar.get(cookieName);
      h.jar.set(cookieName,oldCookie);
      assert.equal((await messages.POST(req({clientRequestId:crypto.randomUUID(),content:'stale'}))).status,401);
      h.jar.set(cookieName,newCookie);
      h.setDifyMode('interrupted');
      const interruptedId=crypto.randomUUID();
      const interrupted=await parse(await messages.POST(req({clientRequestId:interruptedId,content:'断流后的回复'})));
      assert.ok(interrupted.error); assert.equal(interrupted.payload,undefined);
      h.setDifyMode('normal');
      const callsBeforeRecovery=h.difyCalls.length;
      const recovered=(await sessions.GET(req({},'/api/sessions'))).body;
      assert.equal(recovered.pending,false); assert.equal(recovered.messages.length,6);
      assert.equal(h.difyCalls.length,callsBeforeRecovery);
      assert.equal((await pool.query('SELECT status FROM chat_requests WHERE session_id=$1 AND client_request_id=$2',[active.id,interruptedId])).rows[0].status,'completed');
      // Finalization failure is retried from the saved message_end checkpoint.
      const finalizeResponse=await messages.POST(req({clientRequestId:crypto.randomUUID(),content:'数据库暂时写入失败'}));
      failMessageWrite=true;
      const failedFinalize=await parse(finalizeResponse);
      assert.ok(failedFinalize.error);
      failMessageWrite=false;
      const finalized=(await sessions.GET(req({},'/api/sessions'))).body;
      assert.equal(finalized.pending,false); assert.equal(finalized.messages.length,8);
      // Unknown creates are never auto-replayed or silently made retryable.
      h.setDifyMode('no_ids');
      const unknownId=crypto.randomUUID();
      assert.ok((await parse(await messages.POST(req({clientRequestId:unknownId,content:'结果未知'})))).error);
      await pool.query("UPDATE chat_requests SET requested_at=requested_at-interval '200 seconds' WHERE session_id=$1 AND client_request_id<>$2",[active.id,unknownId]);
      await pool.query("UPDATE chat_requests SET requested_at=now()-interval '121 seconds' WHERE session_id=$1 AND client_request_id=$2",[active.id,unknownId]);
      const unknown=(await sessions.GET(req({},'/api/sessions'))).body;
      assert.equal(unknown.pending,false); assert.equal(unknown.failedRequest.retryable,false);
      assert.equal((await messages.POST(req({clientRequestId:unknownId,content:'结果未知'}))).status,409);
      h.setDifyMode('error');
      const denied=await parse(await messages.POST(req({clientRequestId:crypto.randomUUID(),content:'认证失败'})));
      assert.ok(denied.error); assert.equal(JSON.stringify(denied.events).includes(secret),false);
      const failed=(await sessions.GET(req({},'/api/sessions'))).body;
      assert.equal(failed.pending,false); assert.equal(failed.failedRequest.retryable,true);
      assert.match(failed.failedRequest.message,/Dify/); assert.equal(failed.failedRequest.message.includes(secret),false);
      h.setDifyMode('normal');
      // New conversations keep the frozen agent but start with empty context.
      const conversations=h.load('app/api/conversations/route.ts');
      const newConversation=await conversations.POST(req({action:'create'},'/api/conversations'));
      assert.equal(newConversation.status,200); assert.equal(newConversation.body.payload.session.difyConversationId,null);
      await parse(await messages.POST(req({clientRequestId:crypto.randomUUID(),content:'新的独立对话'})));
      assert.equal(h.difyCalls.at(-1).conversation_id,''); assert.notEqual(h.difyCalls.at(-1).user,user);
      assert.equal((await conversations.POST(req({action:'switch',sessionId:active.publicId},'/api/conversations'))).status,200);
      assert.equal((await sessions.GET(req({},'/api/sessions'))).body.session.difyConversationId,firstConv);
      // Same app/key and matching P code across a new experiment remain isolated.
      const otherId='dify-other-study';
      await pool.query('INSERT INTO experiments(id,name) VALUES ($1,$2)',[otherId,'Dify other integration']);
      await settingsLib.saveExperimentSettings({...settings,experiment:{...settings.experiment,id:otherId},
        storage:{databaseMessagesEnabled:false},limits:{maxUserMessages:null,maxMessageChars:2000,sessionDurationMinutes:null},ai:{baseUrl:settings.ai.baseUrl,botId:settings.ai.botId}},adminId);
      const otherAgent=await control.saveAgentConfig({experimentId:otherId,provider:'dify',internalName:'same app',baseUrl:'https://api.dify.ai/v1',botId:'',token:secret,enabled:true},adminId);
      const otherRun=await control.activateExperimentRun({experimentId:otherId,name:'other',assignmentMode:'fixed',fixedAgentId:otherAgent.id,randomAgentIds:[],makeDefault:false},adminId);
      const otherEnroll=await sessions.POST(scopedRequest(otherRun,{profile:{fullName:'Dify student',studentNumber:'dify-student-001'}}));
      assert.equal(otherEnroll.body.session.participantCode,'P001');
      const otherReply=await parse(await messages.POST(scopedRequest(otherRun,{clientRequestId:crypto.randomUUID(),content:'不保存对话正文'} ,'/api/messages')));
      assert.equal(otherReply.payload.messages.length,2); assert.notEqual(h.difyCalls.at(-1).user,user);
      assert.equal(h.difyCalls.at(-1).conversation_id,'');
      const otherSession=await auth.getAuthenticatedSession(await entries.getExperimentEntry(otherRun.entryToken));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE session_id=$1',[otherSession.id])).rows[0].n,0);
      assert.equal(JSON.stringify((await pool.query('SELECT metadata FROM chat_requests WHERE session_id=$1',[otherSession.id])).rows).includes('不保存对话正文'),false);
      assert.equal((await sessions.GET(scopedRequest(otherRun,{},'/api/sessions'))).body.messages.length,2);
      await control.closeActiveExperimentRun(experimentId,adminId,run.id);
      await assert.rejects(()=>control.saveAgentConfig({id:agent.id,experimentId,provider:'coze',internalName:'changed',baseUrl:'https://api.coze.cn',botId:'bot',token:'new',enabled:true},adminId),/AGENT_RECORDS_LOCKED/);
    });
    for (const provider of ['coze','dify']) {
      const experimentId=`key-renewal-${provider}`;
      const firstKey=`synthetic-${provider}-initial-key`, newKey=`synthetic-${provider}-renewed-key`;
      let agent, run, browser, active, firstReply;
      const save = (overrides={}, testAfterSave=false, scope=experimentId) => lifecycleApi.POST(adminRequest({
        action:'save_agent',agent:agentInput(agent,overrides),testAfterSave,
      },scope));
      const row = async () => (await pool.query('SELECT * FROM ai_agent_configs WHERE id=$1',[agent.id])).rows[0];
      const decrypt = stored => h.load('lib/secret-crypto.ts').decryptSecret({
        ciphertext:stored.coze_token_ciphertext,iv:stored.coze_token_iv,tag:stored.coze_token_tag,
      });
      const audits = async () => (await pool.query("SELECT * FROM admin_audit_log WHERE experiment_id=$1 AND action='ai.agent.key.rotate' ORDER BY created_at",[experimentId])).rows;
      const send = async content => {
        const response=await browser.load('app/api/messages/route.ts').POST(browser.request({clientRequestId:crypto.randomUUID(),content},`http://localhost/api/messages?entry=${run.entryToken}`));
        if (provider==='coze') { assert.equal(response.status,200); return response.body; }
        assert.equal(response.status,200);
        const events=(await response.text()).split('\n\n').filter(Boolean).map(frame=>JSON.parse(frame.slice(6)));
        assert.equal(events.some(event=>event.event==='error'),false);
        return events.find(event=>event.event==='completed').payload;
      };
      await t.test(`${provider}: open unused agent permits only encrypted key renewal`, async () => {
        asAdmin();
        await pool.query('INSERT INTO experiments(id,name) VALUES ($1,$2)',[experimentId,experimentId]);
        const settings=await settingsLib.getExperimentSettings('recovery-test',false);
        await settingsLib.saveExperimentSettings({...settings,experiment:{...settings.experiment,id:experimentId},storage:{databaseMessagesEnabled:true},
          limits:{maxUserMessages:null,maxMessageChars:2000,sessionDurationMinutes:null}},adminId);
        agent=await control.saveAgentConfig({experimentId,provider,internalName:`renewal ${provider}`,
          baseUrl:provider==='coze'?'https://api.coze.com':'https://api.dify.ai/v1',
          botId:provider==='coze'?'renewal-fixed-bot':'',token:firstKey,enabled:true},adminId);
        run=await control.activateExperimentRun({experimentId,name:'renewal group',assignmentMode:'fixed',fixedAgentId:agent.id,randomAgentIds:[],makeDefault:false},adminId);
        assert.equal((await save({internalName:'changed',token:newKey})).body.error.code,'ACTIVE_AGENT_LOCKED');
        const renewed=await save({token:`  ${newKey}  `},true);
        assert.equal(renewed.status,200); assert.equal(renewed.body.test.ok,true);
        assert.equal(JSON.stringify(renewed.body).includes(newKey),false);
        const stored=await row();
        assert.equal(decrypt(stored),newKey); assert.notEqual(stored.coze_token_ciphertext,newKey);
        assert.equal(stored.internal_name,agent.internalName); assert.equal(stored.coze_bot_id,provider==='coze'?agent.botId:null);
        assert.equal((await audits()).length,1);
      });
      await t.test(`${provider}: enrolled session uses the renewed key with the original agent and context`, async () => {
        browser=await harness(db,h.sources);
        const enrolled=await browser.load('app/api/sessions/route.ts').POST(browser.request({profile:{fullName:'Key renewal student',studentNumber:`renewal-${provider}-001`}},`http://localhost/api/sessions?entry=${run.entryToken}`));
        assert.equal(enrolled.status,201);
        active=await browser.load('lib/session.ts').getAuthenticatedSession(await entries.getExperimentEntry(run.entryToken));
        firstReply=await send('记住关键词星星');
        const beforeSession=(await pool.query('SELECT * FROM experiment_sessions WHERE id=$1',[active.id])).rows;
        const beforeAssignments=(await pool.query('SELECT * FROM participant_agent_assignments WHERE participant_id=$1',[active.participantId])).rows;
        const beforeRun=(await pool.query('SELECT * FROM experiment_runs WHERE id=$1',[run.id])).rows;
        const result=await save({token:`${newKey}-after-enrollment`},true);
        assert.equal(result.status,200); assert.equal(result.body.test.ok,true);
        assert.deepEqual((await pool.query('SELECT * FROM experiment_sessions WHERE id=$1',[active.id])).rows,beforeSession);
        assert.deepEqual((await pool.query('SELECT * FROM participant_agent_assignments WHERE participant_id=$1',[active.participantId])).rows,beforeAssignments);
        assert.deepEqual((await pool.query('SELECT * FROM experiment_runs WHERE id=$1',[run.id])).rows,beforeRun);
        browser.jar.clear();
        const restored=await browser.load('app/api/sessions/resume/route.ts').POST(browser.request({participantCode:'P001',identity:`renewal-${provider}-001`},`http://localhost/api/sessions/resume?entry=${run.entryToken}`));
        assert.equal(restored.status,200); assert.equal(restored.body.resumed,true);
        const resumed=(await browser.load('app/api/sessions/route.ts').GET(browser.request({},`http://localhost/api/sessions?entry=${run.entryToken}`))).body;
        assert.equal(resumed.messages.length,2); assert.equal(resumed.session.agentId,agent.id);
        const reply=await send('上一轮关键词是什么？');
        assert.equal(reply.messages.length,4); assert.equal(reply.session.participantCode,'P001');
        assert.equal(reply.session.agentId,agent.id);
        if (provider==='coze') {
          assert.equal(browser.cozeConfigs.at(-1).token,`${newKey}-after-enrollment`);
          assert.equal(browser.creates.at(-1).bot_id,agent.botId);
          assert.equal(browser.creates.at(-1).conversation_id,firstReply.session.cozeConversationId);
        } else {
          assert.equal(browser.difyCalls.at(-1).authorization,`Bearer ${newKey}-after-enrollment`);
          assert.equal(browser.difyCalls.at(-1).conversation_id,firstReply.session.difyConversationId);
          assert.equal(browser.difyCalls.at(-1).user,browser.difyCalls.at(-2).user);
        }
        const stored=await row();
        const serialized=JSON.stringify([...await audits(),...(await pool.query('SELECT * FROM messages WHERE session_id=$1',[active.id])).rows]);
        assert.equal(serialized.includes(newKey),false);
        assert.equal(serialized.includes(stored.coze_token_ciphertext),false);
      });
      await t.test(`${provider}: renewal remains admin scoped, rejects mixed edits and preserves blank keys`, async () => {
        const before=await row(), beforeAudits=await audits();
        h.jar.delete('edulab_admin');
        assert.equal((await save({token:'unauthorized-key'})).status,401);
        asAdmin();
        assert.equal((await save({token:'wrong-experiment-key'},false,otherStudy.id)).status,404);
        const crossOrigin=adminRequest({action:'save_agent',agent:agentInput(agent,{token:'cross-origin-key'})},experimentId);
        crossOrigin.headers.set('origin','https://other.example');
        assert.equal((await lifecycleApi.POST(crossOrigin)).status,403);
        for (const overrides of [{internalName:'different'}, {baseUrl:'https://different.example'},
          {botId:'different'}, {enabled:false}, {provider:provider==='coze'?'dify':'coze',botId:'different'}]) {
          const rejected=await save({...overrides,token:'mixed-edit-key'});
          assert.equal(rejected.status,409); assert.equal(rejected.body.error.code,'AGENT_RECORDS_LOCKED');
        }
        assert.equal((await save({token:'   '})).status,200);
        assert.deepEqual(await row(),before); assert.deepEqual(await audits(),beforeAudits);
      });
      await t.test(`${provider}: failed key or audit writes roll back without reporting a successful save`, async () => {
        const before=await row(), beforeAudits=await audits();
        for (const failure of ['key','audit']) {
          failKeyWrite=failure==='key'; failKeyRotateAudit=failure==='audit';
          try { assert.equal((await save({token:`failed-${failure}-key`})).status,500); }
          finally { failKeyWrite=false; failKeyRotateAudit=false; }
          assert.deepEqual(await row(),before); assert.deepEqual(await audits(),beforeAudits);
        }
      });
      if (provider==='dify') await t.test('Dify: saved renewal with a failed connection test reports both outcomes and redacts the key', async () => {
        h.setDifyMode('error');
        let result;
        try { result=await save({token:`${newKey}-connection-failed`},true); }
        finally { h.setDifyMode('normal'); }
        assert.equal(result.status,200); assert.equal(result.body.test.ok,false);
        assert.match(result.body.test.message,/已保存.*连接失败/);
        assert.equal(JSON.stringify(result.body).includes(`${newKey}-connection-failed`),false);
        assert.equal(decrypt(await row()),`${newKey}-connection-failed`);
      });
      await t.test(`${provider}: stopped and deleted entries allow key renewal while retaining configuration locks`, async () => {
        await control.closeActiveExperimentRun(experimentId,adminId,run.id);
        assert.equal((await save({token:`${newKey}-paused`})).status,200);
        await control.deleteExperimentRunLink({experimentId,runId:run.id,confirmationCode:run.entryToken},adminId);
        assert.equal((await save({token:`${newKey}-deleted`})).status,200);
        assert.equal((await save({token:'deleted-mixed-key',enabled:false})).body.error.code,'AGENT_RECORDS_LOCKED');
        assert.equal(decrypt(await row()),`${newKey}-deleted`);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM participants WHERE experiment_id=$1',[experimentId])).rows[0].n,1);
        assert.equal((await pool.query('SELECT count(*)::int AS n FROM messages WHERE session_id=$1',[active.id])).rows[0].n,4);
      });
    }
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
