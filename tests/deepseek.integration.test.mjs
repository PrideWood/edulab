import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import pg from 'pg';
import {z} from 'zod';

test('PostgreSQL DeepSeek configs encrypt keys, lock prompts, preserve credentials and recover a durable reply exactly once',{
  skip:!process.env.DEEPSEEK_TEST_DATABASE_URL,timeout:30000,
},async()=>{
  const client=new pg.Client({connectionString:process.env.DEEPSEEK_TEST_DATABASE_URL});await client.connect();
  await client.query('BEGIN');
  const query=(...args)=>client.query(...args);
  let savepoint=0;
  const transaction=async work=>{
    const point=`deepseek_test_${++savepoint}`;await query(`SAVEPOINT ${point}`);
    try{const result=await work(client);await query(`RELEASE SAVEPOINT ${point}`);return result;}
    catch(error){await query(`ROLLBACK TO SAVEPOINT ${point}`);throw error;}
  };
  const modules={'server-only':{},'node:crypto':crypto,'zod':{z},'@/db':{query,transaction},'next/server':{},'@/lib/coze':{}};
  async function load(file){const exports={};vm.runInNewContext(ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {exports,process:{env:{SETTINGS_ENCRYPTION_KEY:'synthetic-test-encryption-key-at-least-32-chars'}},Buffer,Date,Error,require:name=>modules[name]});return exports;}
  try{
    modules['@/lib/secret-crypto']=await load('lib/secret-crypto.ts');
    modules['@/lib/experiment-settings']={};
    const agents=await load('lib/agent-control.ts');
    const admin=crypto.randomUUID(),participant=crypto.randomUUID(),sessionId=crypto.randomUUID(),requestId=crypto.randomUUID(),cid=crypto.randomUUID();
    await query("INSERT INTO admin_users (id,username,password_hash,display_name) VALUES ($1,$2,'test','test')",[admin,`deepseek-${admin}`]);
    const draft={experimentId:`deepseek-test-${admin}`,internalName:'引导风格',provider:'deepseek',baseUrl:'https://api.deepseek.com',botId:'',token:'sk-synthetic-test-key',enabled:true,
      directModel:{model:'deepseek-flash',systemPrompt:'引导思考。',temperature:0.7,maxTokens:4096,thinking:false}};
    const saved=await agents.saveAgentConfig(draft,admin);
    assert.equal(saved.hasToken,true);assert.equal(saved.directModel.systemPrompt,draft.directModel.systemPrompt);
    assert.equal(JSON.stringify(saved).includes(draft.token),false);
    const stored=(await query('SELECT * FROM ai_agent_configs WHERE id=$1',[saved.id])).rows[0];
    assert.notEqual(stored.coze_token_ciphertext,draft.token);
    assert.equal((await agents.resolveAgentTestConnection({...draft,id:saved.id,token:''})).token,draft.token);
    assert.equal((await agents.saveAgentConfig({...draft,id:saved.id,token:''},admin)).hasToken,true);
    await assert.rejects(()=>agents.resolveAgentTestConnection({...draft,id:saved.id,provider:'dify',token:''}),/PROVIDER_KEY_REQUIRED/);
    await query("INSERT INTO participants (id,experiment_id,external_code) VALUES ($1,$2,'P1')",[participant,draft.experimentId]);
    await query(`INSERT INTO experiment_sessions (id,public_id,participant_id,experiment_id,session_secret_hash,coze_user_id,agent_id,active_request_id,next_sequence,metadata)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2,'{"transcript_authority":"server"}')`,[sessionId,crypto.randomUUID(),participant,draft.experimentId,'0'.repeat(64),crypto.randomUUID(),saved.id,requestId]);
    await assert.rejects(()=>agents.saveAgentConfig({...draft,id:saved.id,directModel:{...draft.directModel,systemPrompt:'换风格'}},admin),/AGENT_RECORDS_LOCKED/);
    await agents.saveAgentConfig({...draft,id:saved.id,token:'sk-synthetic-rotated-key'},admin);
    assert.equal((await query('SELECT direct_model FROM ai_agent_configs WHERE id=$1',[saved.id])).rows[0].direct_model.systemPrompt,draft.directModel.systemPrompt);
    const reply={answer:'先说说你的思路。',messageId:'reply-test',replyStartedAt:new Date().toISOString(),completedAt:new Date().toISOString()};
    await query(`INSERT INTO chat_requests (id,session_id,client_request_id,turn_index,status,metadata)
      VALUES ($1,$2,$3,1,'in_progress',$4::jsonb)`,[requestId,sessionId,cid,JSON.stringify({provider:'deepseek',database_messages_enabled:true,user_content:'问题',user_sequence:1,deepseek_completed_reply:reply})]);
    modules['@/lib/transcript']=await load('lib/transcript.ts');
    modules['@/lib/messages']=await load('lib/messages.ts');
    const chat=await load('lib/deepseek-chat.ts');
    const session={id:sessionId};
    const recovered=await chat.recoverDeepSeekPendingRequest(session);
    assert.equal(recovered.pending,false);assert.equal(recovered.messages.length,2);
    assert.equal(recovered.messages[1].provider,'deepseek');assert.equal(recovered.messages[1].content,reply.answer);
    await chat.recoverDeepSeekPendingRequest(session);
    assert.equal((await query('SELECT count(*)::int AS n FROM messages WHERE session_id=$1',[sessionId])).rows[0].n,2);
    const state=(await query('SELECT active_request_id,next_sequence FROM experiment_sessions WHERE id=$1',[sessionId])).rows[0];
    assert.equal(state.active_request_id,null);assert.equal(state.next_sequence,3);
    const audits=(await query('SELECT after_data FROM admin_audit_log WHERE experiment_id=$1',[draft.experimentId])).rows;
    assert.equal(JSON.stringify(audits).includes(draft.token),false);
  }finally{await query('ROLLBACK');await client.end();}
});
