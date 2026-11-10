import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ts from 'typescript';import vm from 'node:vm';import {z} from 'zod';import * as crypto from 'node:crypto';
const source=ts.transpileModule(await readFile('lib/sql-study-policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const display={};vm.runInNewContext(ts.transpileModule(await readFile('lib/sql-study-display.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:display});
const exports={};vm.runInNewContext(source,{exports,require:n=>n==='zod'?{z}:n.endsWith('sql-study-display')?display:crypto});const p=exports;
const cfg=JSON.parse(await readFile('lib/sql-study-defaults.json','utf8'));
test('SQL classes use nearby pretest pairs with balanced group counts and dispersion',()=>{
 const people=Array.from({length:24},(_,i)=>({name:'S'+i,score:Math.floor(i/2)*5}));let seed=81;const result=p.matchedAssignment(people,m=>{seed=(seed*16807)%2147483647;return seed%m;});
 assert.equal(new Set(result.map(x=>x.name)).size,24);for(let pair=1;pair<=12;pair++){assert.deepEqual(Array.from(result.filter(x=>x.pair===pair).map(x=>x.group)).sort(),['L','T']);}
 const left=p.groupStats(result.filter(x=>x.group==='L').map(x=>x.score)),right=p.groupStats(result.filter(x=>x.group==='T').map(x=>x.score));assert.equal(left.mean,right.mean);assert.equal(left.sd,right.sd);
});
test('odd class conserves every student and differs by only one member',()=>{const r=p.matchedAssignment(Array.from({length:9},(_,i)=>({name:'S'+i,score:i*10})));assert.equal(r.length,9);assert.equal(Math.abs(r.filter(x=>x.group==='L').length-r.filter(x=>x.group==='T').length),1);});
test('invalid schedules cannot be saved; fixed group policy and common lesson scope compose together',()=>{
 assert.equal(p.controlSchema.safeParse(cfg).success,true);const c=structuredClone(cfg);c.schedules['2531'].posttest0={mode:'scheduled',open_at:100,close_at:99};assert.equal(p.controlSchema.safeParse(c).success,false);
 const fixed=p.composeSqlPrompt(cfg,1,'T',3),adaptive=p.composeSqlPrompt(cfg,1,'L',3);assert.ok(fixed.includes('target必须为2'));assert.ok(fixed.includes(cfg.prompts.lessons[1]));assert.ok(adaptive.includes(cfg.prompts.policies.L));assert.ok(!adaptive.includes('target必须为2'));
});
test('group exports escape formula names and preserve quoted CSV contents',()=>{assert.equal(p.csvCell('=SUM(1)'),`"'=SUM(1)"`);assert.equal(p.csvCell('张"三'),`"张""三"`);assert.ok(p.toCsv([['姓名'],['测试']]).startsWith('\ufeff'));});

test('backup is always on, minute values fit an 80-minute class, and only practice supports auto',()=>{
 assert.equal(p.controlSchema.safeParse(cfg).success,true);
 const off=structuredClone(cfg);off.backup_enabled=false;assert.equal(p.controlSchema.safeParse(off).success,false);
 const tooLong=structuredClone(cfg);tooLong.teaching_seconds=1800;assert.equal(p.controlSchema.safeParse(tooLong).success,false);
 const seconds=structuredClone(cfg);seconds.quiz_seconds=61;assert.equal(p.controlSchema.safeParse(seconds).success,false);
 const badAuto=structuredClone(cfg);badAuto.schedules['2531'].posttest0.mode='auto';assert.equal(p.controlSchema.safeParse(badAuto).success,false);
 const good=structuredClone(cfg);good.schedules['2531'].practice0.mode='auto';assert.equal(p.controlSchema.safeParse(good).success,true);
});

test('version summaries describe changed lesson content instead of only showing counters',()=>{const next=structuredClone(cfg);next.tasks[0].checks[0]+=' 新检查';next.prompts.common+=' 自然学生语气';const summary=Array.from(p.summarizeSqlChanges(cfg,next));assert.ok(summary.includes('正式第1课检查点'));assert.ok(summary.includes('更新通用学徒规则与表达方式'));});
test('classroom controls are ordered by measurement and lesson, with each lesson kept together',async()=>{const exports={};vm.runInNewContext(ts.transpileModule(await readFile('lib/sql-study-display.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});const groups=exports.classroomScheduleGroups();assert.deepEqual(Array.from(groups[1].keys),['ai4','practice4','posttest4']);assert.deepEqual(Array.from(groups[2].keys),['ai0','practice0','posttest0']);assert.equal(groups.flatMap(x=>x.keys).length,18);});

test('legacy question-count settings normalize to unlimited without rejecting old controls',()=>{const legacy=structuredClone(cfg);legacy.max_questions=6;assert.equal(p.controlSchema.parse(legacy).max_questions,0);const missing=structuredClone(cfg);delete missing.max_questions;assert.equal(p.controlSchema.parse(missing).max_questions,0);});

test('preparation uses one shared policy regardless of assigned treatment',()=>{
 const left=p.composeSqlPrompt(cfg,4,'L',3),right=p.composeSqlPrompt(cfg,4,'T',3);
 assert.equal(left,right);assert.ok(left.includes(cfg.prompts.preparation));
 assert.ok(!right.includes('target必须为2'));
 const formalLeft=p.composeSqlPrompt(cfg,0,'L',3),formalRight=p.composeSqlPrompt(cfg,0,'T',3);
 assert.notEqual(formalLeft,formalRight);assert.ok(formalRight.includes('target必须为2'));
 const altered=structuredClone(cfg);altered.preparation_timing.teaching_seconds=2400;
 assert.equal(p.controlSchema.safeParse(altered).success,false);
});

test('browser admin reads lesson numbers from the dependency-free display module',async()=>{const panel=await readFile('app/admin/sql-study-panel.tsx','utf8');assert.match(panel,/import type \{SqlControl\} from '@\/lib\/sql-study-policy'/);assert.match(panel,/import \{classroomScheduleGroups,SQL_LESSON_ORDER,sqlLessonNumber[^}]*\} from '@\/lib\/sql-study-display'/);});

test('version history compares legacy three-lesson revisions and transitions without throwing',()=>{
 const old=structuredClone(cfg);old.tasks.pop();old.prompts.lessons.pop();delete old.prompts.preparation;delete old.preparation_timing;
 const next=structuredClone(old);next.tasks[0].brief+=' 历史调整';
 assert.ok(Array.from(p.summarizeSqlChanges(old,next)).includes('正式第1课名称或实操题干'));
 assert.ok(Array.from(p.summarizeSqlChanges(next,cfg)).some(x=>x.startsWith('新增准备课P0')));
 assert.ok(Array.from(p.summarizeSqlChanges(cfg,next)).some(x=>x.startsWith('移除准备课P0')));
});

test('dynamic classes validate uniqueness, reserved codes and complete gates',()=>{
 const next=structuredClone(cfg);next.classes.push({code:'2533',label:'新增班级',planned_size:null,enabled:true});next.schedules['2533']=structuredClone(next.schedules['2531']);assert.equal(p.controlSchema.safeParse(next).success,true);assert.ok(p.activeSqlClasses(next).includes('2533'));
 delete next.schedules['2533'].pretest;assert.equal(p.controlSchema.safeParse(next).success,false);
 const duplicate=structuredClone(cfg);duplicate.classes.push({...duplicate.classes[0]});assert.equal(p.controlSchema.safeParse(duplicate).success,false);
 for(const code of ['__proto__','constructor','<script>']){const bad=structuredClone(cfg);bad.classes[0].code=code;assert.equal(p.controlSchema.safeParse(bad).success,false);}
 const disabled=structuredClone(cfg);disabled.classes.forEach(c=>c.enabled=false);assert.equal(p.controlSchema.safeParse(disabled).success,false);
});
