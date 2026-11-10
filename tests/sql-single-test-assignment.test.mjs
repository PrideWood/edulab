import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import {readFile} from 'node:fs/promises';import * as crypto from 'node:crypto';
const defaults=JSON.parse(await readFile('lib/sql-study-defaults.json','utf8'));
const code=ts.transpileModule(await readFile('lib/sql-study-control.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
class ApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
function setup({record=true,started=false,old=null,rounds=null}={}){const writes=[];const query=async(sql,params)=>{if(sql.startsWith('INSERT INTO sql_study_control'))return {rows:[]};if(sql.includes('SELECT revision,config,updated_at'))return {rows:[{revision:1,config:defaults}]};if(sql.includes('pg_advisory'))return {rows:[]};if(sql.includes('latest_participants'))return {rows:record?[{archive:{study:{pretest:{score:100},group:'L',rounds:rounds??(started?[{}]:[])}}}]:[]};if(sql.includes('FOR UPDATE'))return {rows:old?[old]:[]};writes.push({sql,params});return {rows:[]};};const exports={};vm.runInNewContext(code,{exports,structuredClone,require:n=>n==='server-only'?{}:n==='node:crypto'?crypto:n==='@/db'?{query,transaction:fn=>fn({query})}:n==='@/lib/http'?{ApiError}:n.endsWith('json')?{default:defaults}:n.endsWith('policy')?{activeSqlClasses:c=>c.classes.filter(x=>x.enabled).map(x=>x.code),SQL_STUDY:'sql-teachable-mvp/1'}:(()=>{throw Error(n);})()});return {upgrade:exports.upgradeSqlControl,assign:group=>exports.assignSqlTest('2532','test',group,'admin'),writes};}
test('single test assignment requires a confirmed test record, and rejects normal identities',async()=>{const h=setup({record:false});await assert.rejects(()=>h.assign('L'),e=>e.status===403);assert.equal(h.writes.length,0);});
test('test allocation persists a separately marked group and audit; active lessons cannot switch groups',async()=>{let h=setup();await h.assign('L');assert.match(h.writes[0].sql,/single_test_manual/);assert.equal(h.writes[1].params[2],'test.assign');h=setup({started:true});await assert.rejects(()=>h.assign('T'),e=>e.status===409);assert.equal(h.writes.length,0);});
test('single test controls cannot overwrite a prior paired allocation',async()=>{const h=setup({old:{group_code:'L',method:'class_adjacent_pair_constrained_random_1500'}});await assert.rejects(()=>h.assign('T'),e=>e.code==='FORMAL_ALLOCATION_LOCKED');assert.equal(h.writes.length,0);});

test('old controls are replaced by the agreed scheme without mutating input or reusing switches',()=>{
 const old=structuredClone(defaults);delete old.scheme_version;
 old.tasks=old.tasks.slice(0,4);old.prompts.lessons=old.prompts.lessons.slice(0,4);
 old.tasks[0].brief='旧性别映射';old.schedules['2532'].ai0.mode='open';
 const upgraded=setup().upgrade(old);
 assert.equal(upgraded.tasks.length,5);assert.equal(old.tasks.length,4);
 assert.equal(upgraded.tasks[0].id,'T1');assert.equal(upgraded.tasks[4].id,'P0');
 assert.equal(upgraded.schedules['2532'].ai0.mode,'closed');
 assert.equal(upgraded.preparation_timing.teaching_seconds,900);
 assert.equal(old.tasks[0].brief,'旧性别映射');
 assert.deepEqual(setup().upgrade(upgraded),upgraded);
});

test('first L/T trial locks treatment while legacy common trial can receive a group',async()=>{let h=setup({rounds:[{index:3,group:'L'}]});await assert.rejects(()=>h.assign('T'),e=>e.code==='TEST_ALREADY_STARTED');assert.equal(h.writes.length,0);h=setup({rounds:[{index:4,group:'P'}]});await h.assign('T');assert.equal(h.writes.length,2);});

test('class upgrade preserves current tasks, historical schedules and prompt version',()=>{
 const old=structuredClone(defaults);delete old.classes;delete old.classes_version;old.schedules['旧班']=structuredClone(old.schedules['2531']);old.schedules['旧班'].ai0.mode='open';delete old.schedules['2531'];delete old.schedules['2532'];const before=structuredClone(old);
 const next=setup().upgrade(old);assert.deepEqual(old,before);assert.deepEqual(next.tasks,before.tasks);assert.equal(next.prompt_version,before.prompt_version);assert.equal(next.schedules['旧班'].ai0.mode,'open');assert.equal(next.schedules['2531'].ai0.mode,'closed');assert.deepEqual(next.classes,defaults.classes);assert.deepEqual(setup().upgrade(next),next);
});
