// Synthetic classroom benchmark. Real application functions, isolated schema,
// no Coze calls or production participant reads/writes.
import { readFile, readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import assert from 'node:assert/strict';
import { z } from 'zod';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
const schema = `edulab_check_${randomUUID().replaceAll('-', '')}`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 5,
  connectionTimeoutMillis: 60000, statement_timeout: 60000 });
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 20000 });
const cache = new Map();
async function load(file, modules) {
  if (cache.has(file)) return cache.get(file);
  const exports = {};
  vm.runInNewContext(ts.transpileModule(await readFile(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, Buffer, Date, Error, process: { env: {
    SETTINGS_ENCRYPTION_KEY: 'synthetic-classroom-check-key-only-123456789', COZE_API_TOKEN: 'synthetic-never-sent',
  } }, require: name => {
    if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`);
    return modules[name];
  } });
  cache.set(file, exports);
  return exports;
}
async function transaction(work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    const value = await work(client);
    await client.query('COMMIT');
    return value;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
function stats(values) {
  const ordered = [...values].sort((a,b) => a-b);
  return { medianMs: Math.round(ordered[Math.floor(ordered.length * .5)]),
    p95Ms: Math.round(ordered[Math.ceil(ordered.length * .95) - 1]), maxMs: Math.round(ordered.at(-1)) };
}
await admin.connect();
// Neon transaction pooling does not preserve session SET across queries.
// Scope setup, seeding and assertions to a transaction, just like workers.
const adminQuery = admin.query.bind(admin);
admin.query = async (...args) => {
  await adminQuery('BEGIN');
  try {
    await adminQuery(`SET LOCAL search_path TO "${schema}"`);
    const result = await adminQuery(...args);
    await adminQuery('COMMIT');
    return result;
  } catch (error) { await adminQuery('ROLLBACK'); throw error; }
};
try {
  await admin.query(`CREATE SCHEMA "${schema}"`);
  for (const file of (await readdir('db/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    await admin.query(await readFile(`db/migrations/${file}`, 'utf8'));
  }
  const secret = await load('lib/secret-crypto.ts', { 'server-only': {}, 'node:crypto': crypto });
  const db = { transaction, query: (sql, params) => transaction(client => client.query(sql, params)) };
  const allocator = await load('lib/participant-code-allocation.ts', { 'server-only': {}, 'node:crypto': crypto });
  const profiles = await load('lib/participant-profile.ts', { 'server-only': {}, '@/db': db, '@/lib/secret-crypto': secret });
  const agents = await load('lib/agent-control.ts', { 'server-only': {}, 'node:crypto': crypto, '@/db': db, '@/lib/secret-crypto': secret });
  class ApiError extends Error { constructor(status,code,message) { super(message); this.status=status; this.code=code; } }
  const transcripts = await load('lib/transcript.ts', { 'server-only': {}, 'node:crypto': crypto, zod:{z}, '@/lib/http':{ApiError} });
  const agentIds = [randomUUID(), randomUUID(), randomUUID()];
  const runId = randomUUID();
  for (let i = 0; i < 3; i++) await admin.query(`INSERT INTO ai_agent_configs
    (id,experiment_id,internal_name,coze_bot_id) VALUES ($1,'synthetic',$2,$3)`, [agentIds[i], `Agent ${i}`, `${i}`]);
  await admin.query(`INSERT INTO experiment_runs
    (id,experiment_id,name,status,assignment_mode,fixed_agent_id) VALUES ($1,'synthetic','Classroom','active','fixed',$2)`, [runId,agentIds[0]]);
  const report = { poolMax: 5, cozeCalls: 0, phases: [] };
  const allResults = [];
  for (const mode of ['fixed','balanced_random']) {
    await admin.query(`UPDATE experiment_runs SET assignment_mode=$1,random_agent_ids=$2 WHERE id=$3`, [mode,agentIds,runId]);
    const start = performance.now();
    const results = await Promise.all(Array.from({length:50}, async (_,i) => {
      const begin = performance.now();
      const result = await transaction(async client => {
        const participant = {participantId:randomUUID()};
        await client.query(`INSERT INTO participants (id,experiment_id,external_code) VALUES ($1,'synthetic',$2)`,
          [participant.participantId,`__pending_${participant.participantId}`]);
        const profile = await profiles.saveParticipantProfileWithClient(client,participant.participantId,`Synthetic ${mode} ${i}`,`mock-${mode}-${i}`);
        assert.equal(profile.fullName,`Synthetic ${mode} ${i}`);
        const agent = await agents.assignAgentWithClient(client,'synthetic',participant.participantId);
        const sessionId = randomUUID();
        await client.query(`INSERT INTO experiment_sessions
          (id,public_id,participant_id,experiment_id,session_secret_hash,coze_user_id,experiment_run_id,agent_id)
          VALUES ($1,$2,$3,'synthetic',$4,$5,$6,$7)`,
        [sessionId,randomUUID(),participant.participantId,'a'.repeat(64),randomUUID(),agent.runId,agent.agentId]);
        const numbered = await allocator.createParticipantWithAvailableCode(client,'synthetic', i < 45 ? 'P' : 'T', participant.participantId);
        return {...numbered, sessionId};
      });
      return {...result, elapsedMs:performance.now()-begin};
    }));
    assert.equal(new Set(results.map(r=>r.participantCode)).size,50);
    assert.equal(new Set(results.map(r=>r.participantId)).size,50);
    allResults.push(...results);
    report.phases.push({mode,students:50,successful:results.length,totalMs:Math.round(performance.now()-start),...stats(results.map(r=>r.elapsedMs))});
    console.log(JSON.stringify(report.phases.at(-1)));
  }
  const counts = await admin.query(`SELECT
    (SELECT count(*)::int FROM participants) participants,
    (SELECT count(*)::int FROM participant_identity_profiles) profiles,
    (SELECT count(*)::int FROM experiment_sessions) sessions,
    (SELECT count(DISTINCT external_code)::int FROM participants) unique_codes`);
  assert.deepEqual(counts.rows[0],{participants:100,profiles:100,sessions:100,unique_codes:100});
  report.integrity=counts.rows[0];
  assert.equal((await admin.query(`SELECT count(*)::int n FROM participants WHERE external_code LIKE '__pending_%'`)).rows[0].n,0);
  const fixture = Array.from({length:20},(_,i)=> {
    const turnIndex=i+1, sentAt=new Date().toISOString();
    return [
      {sequenceNo:2*i+1,turnIndex,role:'user',content:`Synthetic question ${i}`,sentAt,clientRequestId:randomUUID(),cozeMessageId:null,cozeChatId:null,replyStartedAt:null,replyCompletedAt:null,latencyMs:null},
      {sequenceNo:2*i+2,turnIndex,role:'assistant',content:`Synthetic reply ${i}`,sentAt,clientRequestId:null,cozeMessageId:null,cozeChatId:null,replyStartedAt:sentAt,replyCompletedAt:sentAt,latencyMs:0},
    ];
  }).flat();
  const uploadStart=performance.now();
  const timings=await Promise.all(allResults.slice(0,50).map(async result=> {
    const start=performance.now();
    await transaction(client=>transcripts.persistTranscript(client,result.sessionId,fixture,{requireComplete:true,storageMode:'automatic_completion'}));
    return performance.now()-start;
  }));
  report.phases.push({mode:'transcript_upload',students:50,turnsPerStudent:20,totalMs:Math.round(performance.now()-uploadStart),...stats(timings)});
  // Simultaneous retries, including an older user-only snapshot, must not
  // downgrade a completed request or duplicate either side of the conversation.
  await Promise.all([fixture,fixture,fixture.filter(m=>m.role==='user')].map(messages=>transaction(client=>
    transcripts.persistTranscript(client,allResults[0].sessionId,messages,{requireComplete:false,storageMode:'background_checkpoint'}))));
  await transaction(async client=> {
    const result=await transcripts.verifyStoredTranscript(client,allResults[0].sessionId,40);
    assert.equal(result.turns,20);
  });
  const recordCounts=(await admin.query(`SELECT (SELECT count(*)::int FROM messages) messages,
    (SELECT count(*)::int FROM chat_requests WHERE status='completed') completed_turns,
    (SELECT count(*)::int FROM chat_requests WHERE user_message_id IS NULL) missing_user_links`)).rows[0];
  assert.deepEqual(recordCounts,{messages:2000,completed_turns:1000,missing_user_links:0});
  report.transcriptIntegrity=recordCounts;
  report.duplicateAndStaleUploads='passed';
  console.log(JSON.stringify(report,null,2));
} finally {
  await pool.end();
  // Only this invocation's generated schema is removed; no CASCADE on public.
  await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  await admin.end();
  console.log('Isolated test schema removed.');
}
