import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import { randomBytes,randomUUID } from 'node:crypto';
import pg from 'pg';

test('entry migration preserves historical records, gives distinct short codes and permits concurrent groups', { skip:!process.env.DATABASE_URL }, async () => {
  const url = new URL(process.env.DATABASE_URL);
  url.hostname = url.hostname.replace('-pooler.','.');
  const client = new pg.Client({ connectionString:url.toString(),connectionTimeoutMillis:10000 });
  const schema = `edulab_entry_test_${randomBytes(8).toString('hex')}`;
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path=${schema}`);
    const files = (await readdir('db/migrations')).filter(file => file.endsWith('.sql')).sort();
    for (const file of files.filter(file => file < '0011')) await client.query(await readFile(`db/migrations/${file}`,'utf8'));
    const agentId = randomUUID(),participantId = randomUUID(),activeId = randomUUID();
    await client.query("INSERT INTO ai_agent_configs (id,experiment_id,internal_name,coze_bot_id) VALUES ($1,'legacy-study','原智能体','synthetic-bot')",[agentId]);
    await client.query("INSERT INTO participants (id,experiment_id,external_code,metadata) VALUES ($1,'legacy-study','P001','{\"legacy_value\":true}')",[participantId]);
    await client.query("INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,fixed_agent_id) VALUES ($1,'legacy-study','原开放场次','active','fixed',$2)",[activeId,agentId]);
    for (let i=0;i<12;i++) await client.query("INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,fixed_agent_id) VALUES ($1,'legacy-study',$2,'closed','fixed',$3)",[randomUUID(),`旧场次${i}`,agentId]);
    await client.query(`INSERT INTO experiment_sessions (id,public_id,participant_id,experiment_id,session_secret_hash,coze_user_id,experiment_run_id,agent_id,config_snapshot)
      VALUES ($1,$2,$3,'legacy-study',$4,'synthetic-legacy-user',$5,$6,'{"legacy_snapshot":true}')`,[randomUUID(),randomUUID(),participantId,'f'.repeat(64),activeId,agentId]);
    const originalParticipant = (await client.query('SELECT * FROM participants')).rows;
    const originalSessions = (await client.query('SELECT * FROM experiment_sessions')).rows;
    await client.query(await readFile('db/migrations/0011_experiment_entry_links.sql','utf8'));
    assert.deepEqual((await client.query('SELECT * FROM participants')).rows,originalParticipant);
    assert.deepEqual((await client.query('SELECT * FROM experiment_sessions')).rows,originalSessions);
    assert.equal((await client.query('SELECT id FROM experiments')).rows[0].id,'legacy-study');
    const runs = (await client.query('SELECT * FROM experiment_runs')).rows;
    assert.equal(runs.length,13);
    assert.equal(runs.filter(run => run.is_default).length,1);
    assert.equal(runs.find(run => run.is_default).id,activeId);
    for (const run of runs) assert.match(run.entry_token,/^[abcdefghjkmnpqrstuvwxyz23456789]{4}-[abcdefghjkmnpqrstuvwxyz23456789]{4}$/);
    for (let i=0;i<runs.length;i++) for (let j=i+1;j<runs.length;j++) {
      const a = runs[i].entry_token.replace('-',''),b = runs[j].entry_token.replace('-','');
      assert.ok([...a].filter((char,index) => char !== b[index]).length >= 4);
    }
    await client.query("INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,fixed_agent_id,entry_token) VALUES ($1,'legacy-study','并行组','active','fixed',$2,'qrst-6789')",[randomUUID(),agentId]);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM experiment_runs WHERE status='active'")).rows[0].n,2);
    await assert.rejects(() => client.query("INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,fixed_agent_id,entry_token) VALUES ($1,'legacy-study','冲突组','closed','fixed',$2,'qrst-6789')",[randomUUID(),agentId]),error => error.code === '23505');
  } finally {
    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await client.end();
  }
});
