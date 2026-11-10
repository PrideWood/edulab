import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import {readFile} from 'node:fs/promises';
import * as crypto from 'node:crypto';
import {z} from 'zod';
const compile=async file=>ts.transpileModule(await readFile(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const display={};vm.runInNewContext(await compile('lib/sql-study-display.ts'),{exports:display});
const policy={};vm.runInNewContext(await compile('lib/sql-study-policy.ts'),{exports:policy,require:n=>n==='zod'?{z}:n.endsWith('sql-study-display')?display:crypto});
const code=await compile('lib/sql-study-control.ts');
const defaults=JSON.parse(await readFile('lib/sql-study-defaults.json','utf8'));
class ApiError extends Error {constructor(status,code,message){super(message);this.status=status;this.code=code;}}
function setup(rows){let writes=0;const api={};vm.runInNewContext(code,{exports:api,structuredClone,require:n=>({'server-only':{},'node:crypto':crypto,'@/db':{query:async()=>({rows}),transaction:()=>{writes++;throw Error('unexpected write');}},'@/lib/http':{ApiError},'./sql-study-defaults.json':{default:defaults},'./sql-study-policy':policy})[n]});return {api,writes:()=>writes};}
test('dashboard version loader handles historical three-course revisions alongside four-course revisions',async()=>{
 const legacy=structuredClone(defaults);legacy.tasks.pop();legacy.prompts.lessons.pop();delete legacy.preparation_timing;delete legacy.prompts.preparation;
 const changed=structuredClone(legacy);changed.tasks[0].brief+=' 历史修改';
 const rows=[legacy,changed,defaults].map((config,i)=>({revision:i+1,prompt_version:i+1,config,summary:i?['历史配置更新']:['初始配置'],updated_at:null}));
 const h=setup(rows);const result=await h.api.getSqlVersions();
 assert.equal(result.length,3);assert.equal(result[0].revision,3);
 assert.ok(result[0].summary.some(s=>s.startsWith('新增准备课P0')));
 assert.ok(result[1].summary.includes('正式第1课名称或实操题干'));assert.equal(h.writes(),0);
});
test('automatic choice assessments cannot be overwritten by historical SQL grades',async()=>{
 const h=setup([{archive:{study:{rounds:[{index:3,quiz:{format:'single_choice',score:70}}]}}}]);
 await assert.rejects(h.api.gradeSql({deviceId:'device',participantId:'student',lesson:3,scores:[20,20]},'admin'),e=>e.code==='AUTOMATIC_QUIZ');
 assert.equal(h.writes(),0);
});

test('saving the new scheme preserves the raw prior control before upgrading its active defaults',async()=>{
 const old=structuredClone(defaults);delete old.scheme_version;delete old.dataset_version;old.tasks=old.tasks.slice(0,4);old.tasks[0].brief='原始旧任务';
 const before=structuredClone(old),calls=[],api={};
 const query=async(sql,params)=>{
  if(sql.includes('FOR UPDATE'))return {rows:[{revision:9,config:structuredClone(old)}]};
  calls.push({sql,params});
  if(sql.includes('RETURNING'))return {rows:[{revision:10,summary:[]}]};
  return {rows:[]};
 };
 vm.runInNewContext(code,{exports:api,structuredClone,require:n=>({'server-only':{},'node:crypto':crypto,'@/db':{transaction:fn=>fn({query})},'@/lib/http':{ApiError},'./sql-study-defaults.json':{default:defaults},'./sql-study-policy':policy})[n]});
 const result=await api.saveSqlControl(structuredClone(defaults),9,'admin');assert.equal(result.revision,10);
 const audit=JSON.parse(calls.find(c=>c.sql.includes('sql_study_audit')).params[3]);
 assert.deepEqual(audit.before.config,before);assert.equal(audit.after.scheme_version,'business-workorders/1');
 const savedPrior=calls.find(c=>c.sql.includes('ON CONFLICT DO NOTHING'));
 assert.deepEqual(JSON.parse(savedPrior.params[2]),before);
 assert.ok(!calls.some(c=>/sql_study_assignments|DELETE/.test(c.sql)));
});
