// Opt-in real PostgreSQL lifecycle test. All fixture data and audit rows roll back.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import pg from 'pg';
import ts from 'typescript';
import * as fflate from 'fflate';

test('PostgreSQL recycle lifecycle preserves archives, survives new uploads and restores export eligibility',{
  skip:!process.env.LOCAL_RECYCLE_TEST_DATABASE_URL,timeout:120000,
},async()=>{
  const client=new pg.Client({connectionString:process.env.LOCAL_RECYCLE_TEST_DATABASE_URL,connectionTimeoutMillis:20000,statement_timeout:20000});
  await client.connect();
  try{
    await client.query('BEGIN');
    class ApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
    const query=(...args)=>client.query(...args);
    const transaction=async work=>{await client.query('SAVEPOINT recycle_test');try{const result=await work(client);await client.query('RELEASE SAVEPOINT recycle_test');return result;}catch(e){await client.query('ROLLBACK TO SAVEPOINT recycle_test');throw e;}};
    async function load(file){const exports={};const js=ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
      vm.runInNewContext(js,{exports,require:name=>({'server-only':{},'node:crypto':{randomUUID},'@/db':{query,transaction},'@/lib/http':{ApiError},'fflate':fflate})[name]});return exports;}
    const list=await load('lib/local-backups.ts'),recycle=await load('lib/local-backup-recycle.ts'),zip=await load('lib/local-backup-export.ts');
    const admin=(await query('SELECT id FROM admin_users WHERE is_active=true LIMIT 1')).rows[0]?.id;assert.ok(admin);
    const a={deviceId:randomUUID(),participantId:randomUUID()},b={deviceId:randomUUID(),participantId:a.participantId};
    const name='回收站验证-'+randomUUID().slice(0,8),stamp=new Date().toISOString(),cid=randomUUID();
    const fixture=ref=>({schema_version:'edulab-light/1',source_app:'student-light',device_id:ref.deviceId,participant:{id:ref.participantId,name,class_code:'3',created_at:stamp},backup_revision:1,
      conversations:[{id:cid,title:'synthetic verification',created_at:stamp,updated_at:stamp,status:'active',agent:{id:'synthetic',name:'test',provider:'coze',bot_id:'synthetic'},messages:[{id:randomUUID(),request_id:'r1',role:'user',content:'测试问题',sent_at:stamp,sequence_no:1,turn_index:1},{id:randomUUID(),request_id:'r1',role:'assistant',content:'测试回答',sent_at:stamp,sequence_no:2,turn_index:1}],requests:[{id:'r1',turn_index:1,status:'completed',requested_at:stamp,first_reply_at:stamp,completed_at:stamp}]}]});
    async function ingest(archive){const text=JSON.stringify(archive),sha=createHash('sha256').update(text).digest('hex');return query('SELECT edulab_local_backup.ingest($1,$2,$3,$4)',[`${archive.device_id}:${archive.participant.id}:${sha}`,sha,text,stamp]);}
    const first=fixture(a);await ingest(first);await ingest(fixture(b));
    assert.equal((await list.listLocalBackups({page:1,search:name})).total,2);
    assert.equal((await recycle.setLocalBackupsRecycled([a,{deviceId:a.deviceId.toUpperCase(),participantId:a.participantId}], 'trash',admin)).changedCount,1);
    assert.equal((await recycle.setLocalBackupsRecycled([a],'trash',admin)).changedCount,0);
    let active=await list.listLocalBackups({page:1,search:name});assert.equal(active.total,1);assert.equal(active.records[0].deviceId,b.deviceId);
    let trash=await list.listLocalBackups({page:1,search:name,view:'trash'});assert.equal(trash.total,1);assert.ok(trash.records[0].trashedAt);
    await assert.rejects(()=>list.getLocalBackup(a.deviceId,a.participantId),e=>e.status===404);
    assert.equal((await list.getLocalBackup(a.deviceId,a.participantId,'trash')).conversations[0].messages.length,2);
    await assert.rejects(()=>zip.buildLocalBackupZip([a,b]),e=>e.status===404);
    assert.equal((await zip.buildLocalBackupZip([b])).count,1);
    const next=structuredClone(first);next.backup_revision=2;next.conversations[0].messages.push({id:randomUUID(),request_id:'r2',role:'user',content:'后续问题',sent_at:stamp,sequence_no:3,turn_index:2},{id:randomUUID(),request_id:'r2',role:'assistant',content:'后续回答',sent_at:stamp,sequence_no:4,turn_index:2});await ingest(next);
    assert.equal((await list.listLocalBackups({page:1,search:name})).total,1);
    trash=await list.listLocalBackups({page:1,search:name,view:'trash'});assert.equal(trash.records[0].messageCount,4);
    await assert.rejects(()=>recycle.setLocalBackupsRecycled([b,{deviceId:randomUUID(),participantId:randomUUID()}],'trash',admin),e=>e.status===404);
    assert.equal((await list.listLocalBackups({page:1,search:name})).total,1);
    assert.equal((await recycle.setLocalBackupsRecycled([a],'restore',admin)).changedCount,1);
    active=await list.listLocalBackups({page:1,search:name});assert.equal(active.total,2);
    const file=await zip.buildLocalBackupZip([a,b]);assert.equal(Object.keys(fflate.unzipSync(file.bytes)).length,2);
    const original=await query('SELECT archive FROM edulab_local_backup.snapshots WHERE device_id=$1 AND participant_id=$2 AND revision=1',[a.deviceId,a.participantId]);
    assert.deepEqual(original.rows[0].archive.conversations[0].messages,first.conversations[0].messages);
    const audit=await query("SELECT action FROM admin_audit_log WHERE after_data->'records'->0->>'deviceId'=$1 ORDER BY action",[a.deviceId]);assert.deepEqual(audit.rows.map(r=>r.action),['local.backup.restore','local.backup.trash']);
    const permissions=await query("SELECT has_table_privilege('edulab_light_uploader','public.local_backup_dispositions','UPDATE') AS can_restore");assert.equal(permissions.rows[0].can_restore,false);
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
});
