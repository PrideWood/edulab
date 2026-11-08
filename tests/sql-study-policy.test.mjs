import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import ts from 'typescript';import vm from 'node:vm';import {z} from 'zod';import * as crypto from 'node:crypto';
const source=ts.transpileModule(await readFile('lib/sql-study-policy.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const exports={};vm.runInNewContext(source,{exports,require:n=>n==='zod'?{z}:crypto});const p=exports;
const cfg=JSON.parse(await readFile('lib/sql-study-defaults.json','utf8'));
test('SQL classes use nearby pretest pairs with balanced group counts and dispersion',()=>{
 const people=Array.from({length:24},(_,i)=>({name:'S'+i,score:Math.floor(i/2)*5}));let seed=81;const result=p.matchedAssignment(people,m=>{seed=(seed*16807)%2147483647;return seed%m;});
 assert.equal(new Set(result.map(x=>x.name)).size,24);for(let pair=1;pair<=12;pair++){assert.deepEqual(Array.from(result.filter(x=>x.pair===pair).map(x=>x.group)).sort(),['L','T']);}
 const left=p.groupStats(result.filter(x=>x.group==='L').map(x=>x.score)),right=p.groupStats(result.filter(x=>x.group==='T').map(x=>x.score));assert.equal(left.mean,right.mean);assert.equal(left.sd,right.sd);
});
test('odd class conserves every student and differs by only one member',()=>{const r=p.matchedAssignment(Array.from({length:9},(_,i)=>({name:'S'+i,score:i*10})));assert.equal(r.length,9);assert.equal(Math.abs(r.filter(x=>x.group==='L').length-r.filter(x=>x.group==='T').length),1);});
test('invalid schedules cannot be saved; fixed group policy and common lesson scope compose together',()=>{
 assert.equal(p.controlSchema.safeParse(cfg).success,true);const c=structuredClone(cfg);c.schedules['计网2541'].posttest0={mode:'scheduled',open_at:100,close_at:99};assert.equal(p.controlSchema.safeParse(c).success,false);
 const fixed=p.composeSqlPrompt(cfg,1,'T',3),adaptive=p.composeSqlPrompt(cfg,1,'L',3);assert.ok(fixed.includes('target必须为2'));assert.ok(fixed.includes(cfg.prompts.lessons[1]));assert.ok(adaptive.includes(cfg.prompts.policies.L));assert.ok(!adaptive.includes('target必须为2'));
});
test('group exports escape formula names and preserve quoted CSV contents',()=>{assert.equal(p.csvCell('=SUM(1)'),`"'=SUM(1)"`);assert.equal(p.csvCell('张"三'),`"张""三"`);assert.ok(p.toCsv([['姓名'],['测试']]).startsWith('\ufeff'));});

test('backup is always on, minute values fit an 80-minute class, and only practice supports auto',()=>{
 assert.equal(p.controlSchema.safeParse(cfg).success,true);
 const off=structuredClone(cfg);off.backup_enabled=false;assert.equal(p.controlSchema.safeParse(off).success,false);
 const tooLong=structuredClone(cfg);tooLong.teaching_seconds=1800;assert.equal(p.controlSchema.safeParse(tooLong).success,false);
 const seconds=structuredClone(cfg);seconds.quiz_seconds=61;assert.equal(p.controlSchema.safeParse(seconds).success,false);
 const badAuto=structuredClone(cfg);badAuto.schedules['计网2541'].posttest0.mode='auto';assert.equal(p.controlSchema.safeParse(badAuto).success,false);
 const good=structuredClone(cfg);good.schedules['计网2541'].practice0.mode='auto';assert.equal(p.controlSchema.safeParse(good).success,true);
});

test('version summaries describe changed lesson content instead of only showing counters',()=>{const next=structuredClone(cfg);next.tasks[0].checks[0]+=' 新检查';next.prompts.common+=' 自然学生语气';const summary=Array.from(p.summarizeSqlChanges(cfg,next));assert.ok(summary.includes('第1课检查点'));assert.ok(summary.includes('更新通用学徒规则与表达方式'));});
test('classroom controls are ordered by measurement and lesson, with each lesson kept together',async()=>{const exports={};vm.runInNewContext(ts.transpileModule(await readFile('lib/sql-study-display.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});const groups=exports.classroomScheduleGroups();assert.deepEqual(Array.from(groups[1].keys),['ai0','practice0','posttest0']);assert.deepEqual(Array.from(groups[2].keys),['ai1','practice1','posttest1']);assert.equal(groups.flatMap(x=>x.keys).length,12);});
