import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
const data=JSON.parse(await readFile('docs/sql-workorders/teaching-database-fixture.json','utf8'));
const config=JSON.parse(await readFile('lib/sql-study-defaults.json','utf8'));
const trim=v=>typeof v==='string'?v.trimEnd():v;
const grades=data.tables['成绩表'];
const k01=grades.filter(r=>trim(r['选修课程编号'])==='K01');
const assigned=k01.filter(r=>['B01','B02'].includes(trim(r['班级编号'])));
test('real export retains unassigned K01 records but core class reports explicitly scope both assigned classes',()=>{
 assert.equal(grades.length,21);assert.equal(k01.length,7);assert.equal(k01.filter(r=>r['班级编号']===null).length,2);
 assert.equal(assigned.length,5);assert.equal(assigned.reduce((n,r)=>n+r['成绩'],0),418);
 for(const i of [1,3]){assert.match(config.tasks[i].brief,/B01或B02/);assert.match(config.tasks[i].brief,/未分配班级/);}
 const nullScores=k01.filter(r=>r['班级编号']===null).map(r=>r['成绩']);assert.equal(nullScores.reduce((a,b)=>a+b,0)/nullScores.length,89.5);
 assert.equal(new Set(grades.map(r=>trim(r['学生编号'])+':'+trim(r['选修课程编号']))).size,21);
});
test('student filters and fixed reference ages agree with the actual thirteen-student export',()=>{
 const students=data.tables['学生表'];assert.equal(students.length,13);
 const selected=students.filter(r=>(r['籍贯']==='北京市'||r['籍贯'].startsWith('黑龙江省'))&&r['出生日期']>='1978-01-01'&&r['出生日期']<'1982-01-01');
 assert.deepEqual(selected.map(r=>r['学生姓名']),['宋小南','张经纬','王旭']);
 const ages=selected.map(r=>2022-Number(r['出生日期'].slice(0,4)));assert.equal(Math.min(...ages),41);assert.equal(Math.max(...ages),44);
 const report=students.filter(r=>(r['职务']==='班长'||r['所属班级编号']==='B03')&&r['入学日期']<'2002-09-01');
 assert.deepEqual(report.map(r=>r['学生姓名']),['宋小南','王霞','王旭']);
});
test('ANY ALL populations and weighted class averages are independently checked against exported rows',()=>{
 const one=assigned.filter(r=>trim(r['班级编号'])==='B01'),two=assigned.filter(r=>trim(r['班级编号'])==='B02');
 const any=two.filter(r=>one.some(x=>r['成绩']>x['成绩']));const all=two.filter(r=>one.every(x=>r['成绩']>x['成绩']));
 assert.equal(any.length,2);assert.deepEqual(all.map(r=>trim(r['学生编号'])),['X005']);
 assert.deepEqual(one.filter(r=>two.every(x=>r['成绩']<x['成绩'])).map(r=>trim(r['学生编号'])),['X003']);
 const mean=xs=>xs.reduce((a,r)=>a+r['成绩'],0)/xs.length;
 assert.equal(mean(one),83);assert.equal(mean(two),84.5);assert.equal(mean(assigned),83.6);assert.notEqual((mean(one)+mean(two))/2,mean(assigned));
});
