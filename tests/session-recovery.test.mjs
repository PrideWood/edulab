import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import { z } from 'zod';

// Run actual application SQL against a disposable, uniquely named schema.
// Every connection explicitly uses ONLY that schema; no public table is touched.
async function harness(db) {
  const files = ['config/experiment.ts', 'lib/security.ts', 'lib/secret-crypto.ts',
    'lib/session.ts', 'lib/session-usage.ts', 'lib/session-write.ts', 'lib/http.ts', 'lib/admin-auth.ts',
    'lib/participant-profile.ts', 'lib/participant-code-allocation.ts', 'lib/agent-control.ts',
    'lib/experiment-settings.ts', 'lib/experiment-limits.ts', 'lib/messages.ts', 'lib/coze.ts',
    'lib/transcript.ts', 'lib/session-payload.ts', 'lib/runtime-session.ts', 'lib/session-draft.ts',
    'lib/participant-recovery.ts', 'lib/legacy-runtime.ts', 'app/api/sessions/route.ts',
    'app/api/sessions/resume/route.ts', 'app/api/sessions/draft/route.ts',
    'app/api/sessions/complete/route.ts', 'app/api/sessions/checkpoint/route.ts', 'app/api/messages/route.ts', 'app/api/conversations/route.ts'];
  const sources = new Map(await Promise.all(files.map(async file => [file,
    ts.transpileModule(await readFile(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText])));
  const jar = new Map(), cache = new Map(), chats = new Map(), creates = [];
  let providerPending = false;
  class CozeAPI {
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
    'server-only': {}, 'node:crypto': crypto, zod: { z }, '@/db': db,
    '@/lib/participant-code': { isTestParticipantName: value => ['test','测试','ceshi'].includes(value.trim().toLowerCase()) },
    'next/headers': { cookies: async () => ({ get: key => jar.has(key) ? { value: jar.get(key) } : undefined }) },
    'next/server': { NextResponse: { json: (body, options = {}) => ({ body:JSON.parse(JSON.stringify(body)), status: options.status ?? 200, cookies: { set: (key, value, opts) => opts.maxAge === 0 ? jar.delete(key) : jar.set(key, value) } }) } },
    '@coze/api': { CozeAPI, RoleType: { User:'user', Assistant:'assistant' }, ChatStatus: { COMPLETED:'completed', FAILED:'failed', CANCELED:'canceled', REQUIRES_ACTION:'requires_action' } },
  };
  function load(file) {
    if (cache.has(file)) return cache.get(file);
    const exports = {};
    cache.set(file, exports);
    vm.runInNewContext(sources.get(file), { exports, Buffer, URL, Date, Error, console, AbortSignal, setTimeout, clearTimeout,
      process: { env: { EXPERIMENT_ID:'recovery-test', COZE_API_TOKEN:'synthetic-token', COZE_BOT_ID:'synthetic-bot',
        SETTINGS_ENCRYPTION_KEY:'synthetic-test-encryption-key-at-least-32', NODE_ENV:'test' } },
      require: name => {
        if (name in mocks) return mocks[name];
        if (name.startsWith('@/')) return load(`${name.slice(2)}.ts`);
        throw new Error(`Unexpected module ${name}`);
      },
    });
    return exports;
  }
  const request = (body, url = 'http://localhost/api/sessions') => ({ url, headers: new Headers({ origin:'http://localhost' }), json:async () => JSON.parse(JSON.stringify(body)) });
  return { load, jar, request, creates, setPending:value => { providerPending = value; } };
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
    let failMessageWrite = false;
    const query = async (sql, values) => {
      if (failMessageWrite && /INSERT INTO messages/.test(sql)) throw new Error('synthetic database write failure');
      return pool.query(sql, values);
    };
    const db = { query, transaction:async work => {
      const client = await pool.connect();
      const facade = { query:async (sql, values) => {
        if (failMessageWrite && /INSERT INTO messages/.test(sql)) throw new Error('synthetic database write failure');
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
    await pool.query(`INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,random_agent_ids)
      VALUES ($1,'recovery-test','课堂','active','balanced_random',$2)`, [runId, agentIds]);
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
    await pool.query(`INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,fixed_agent_id) VALUES ($1,'recovery-test','新场次','active','fixed',$2)`, [crypto.randomUUID(), agentIds.find(id => id !== payload.session.agentId)]);
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
      const created = await sessions.POST(h.request({ profile:{ fullName:'测试', studentNumber:'' } }));
      assert.equal(created.status, 201);
      assert.equal(created.body.session.participantCode, 'T001');
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
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
});
