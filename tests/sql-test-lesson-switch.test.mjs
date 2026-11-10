import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import {readFile} from 'node:fs/promises';import * as crypto from 'node:crypto';
const code=ts.transpileModule(await readFile('lib/sql-study-control.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class ApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
function setup(testRecord=true){const calls=[];const exports={};const query=async(sql,params)=>{calls.push({sql,params});if(sql.includes('latest_participants'))return {rows:testRecord?[{is_test:true}]:[]};return {rows:[]};};vm.runInNewContext(code,{exports,require:n=>n==='server-only'?{}:n==='node:crypto'?crypto:n==='@/db'?{query}:n==='@/lib/http'?{ApiError}:n.endsWith('json')?{default:{}}:n.endsWith('policy')?{SQL_STUDY:'sql-teachable-mvp/1'}:null});return {api:exports,calls};}
const input={deviceId:'device',participantId:'student',lesson:3};
test('test lesson selection requires verified non-trashed test identity and never changes group or class config',async()=>{
 const denied=setup(false);await assert.rejects(denied.api.selectSqlTestLesson(input,'admin'),e=>e.status===403);assert.equal(denied.calls.length,1);
 const h=setup();const result=await h.api.selectSqlTestLesson(input,'admin');assert.equal(result.ok,true);assert.equal(result.lesson,3);
 assert.match(h.calls[0].sql,/p\.is_test/);assert.match(h.calls[0].sql,/is_trashed/);
 assert.equal(h.calls[1].params[2],'test.lesson.select');assert.deepEqual(JSON.parse(h.calls[1].params[3]),{...input,scheme_version:'business-workorders/1',research_version:'sql-lt/1.1'});
 assert.ok(h.calls.every(c=>!c.sql.includes('UPDATE')&&!c.sql.includes('sql_study_assignments')));
 await assert.rejects(h.api.selectSqlTestLesson({...input,lesson:5},'admin'),e=>e.status===400);
});
test('client receives only latest commands for its exact device',async()=>{const h=setup();await h.api.getSqlTestLessonCommands('device');assert.match(h.calls[0].sql,/DISTINCT ON/);assert.match(h.calls[0].sql,/created_at DESC/);assert.deepEqual(Array.from(h.calls[0].params),['device']);});
