import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
const lib={};
vm.runInNewContext(ts.transpileModule(await readFile('lib/roster-allocation.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports:lib});
const agents=['A','B','C'];
const normalize=value=>JSON.parse(JSON.stringify(value));
const students=(sizes)=>sizes.flatMap((n,c)=>Array.from({length:n},(_,i)=>({className:`班${c}`,fullName:`学生${String(i).padStart(3,'0')}`,score:100-c*10-i})));

test('every class and stratum is equally represented in agent groups when divisible',()=>{
  const rows=lib.allocateRoster(students([27,36]),agents);
  for(const className of ['班0','班1']) for(const layer of lib.STRATA) {
    const counts=agents.map(agent=>rows.filter(row=>row.className===className && row.stratum===layer && row.agentId===agent).length);
    assert.equal(new Set(counts).size,1);
  }
  assert.equal(rows.length,63);
  assert.ok(lib.rosterStatistics(rows,agents).every(stat=>stat.n===21 && stat.sd>0));
});
test('allocation is independent of source order and stable for score ties and distinct names',()=>{
  const input=students([29,31]).map(row=>({...row,score:80}));
  assert.deepEqual(normalize(lib.allocateRoster(input,agents)),normalize(lib.allocateRoster([...input].reverse(),agents)));
});
test('all small/uneven class sizes conserve students and keep layer and class counts within one',()=>{
  for(let size=1;size<=80;size++) {
    const rows=lib.allocateRoster(students([size,size+1,size+4]),agents);
    assert.equal(rows.length,size*3+5);
    for(const className of ['班0','班1','班2']) {
      const classCounts=agents.map(agent=>rows.filter(row=>row.className===className && row.agentId===agent).length);
      assert.ok(Math.max(...classCounts)-Math.min(...classCounts)<=1,`class size ${size}`);
      for(const layer of lib.STRATA) {
        const counts=agents.map(agent=>rows.filter(row=>row.className===className && row.stratum===layer && row.agentId===agent).length);
        assert.ok(Math.max(...counts)-Math.min(...counts)<=1);
      }
    }
  }
});
test('invalid identities, missing scores and partial strata are rejected; class disambiguates names',()=>{
  assert.throws(()=>lib.allocateRoster([{className:'A',fullName:' 张三 ',score:90},{className:'A',fullName:'张三',score:80}],agents),/重复/);
  assert.equal(lib.allocateRoster([{className:'A',fullName:'张三',score:90},{className:'B',fullName:'张三',score:80}],agents).length,2);
  assert.throws(()=>lib.allocateRoster([{className:'A',fullName:'甲',score:NaN}],agents),/成绩/);
  assert.throws(()=>lib.allocateRoster([{className:'A',fullName:'甲',score:90,stratum:'高'},{className:'A',fullName:'乙',score:80}],agents),/全部/);
  assert.throws(()=>lib.allocateRoster(students([3]),['A','A']),/不同/);
});
test('teacher-specified layers and final assignments remain exact and stats handle empty groups',()=>{
  const input=[{className:'班',fullName:'甲',score:90,stratum:'中',agentId:'B'},{className:'班',fullName:'乙',score:20,stratum:'低',agentId:'B'}];
  const rows=lib.allocateRoster(input,agents,true);
  assert.ok(rows.every(row=>row.agentId==='B'));
  assert.equal(rows.find(row=>row.fullName==='甲').stratum,'中');
  const stats=lib.rosterStatistics(rows,agents);
  assert.equal(stats[0].mean,null);assert.equal(stats[1].mean,55);
  assert.throws(()=>lib.allocateRoster([{...input[0],agentId:'unknown'}],agents,true),/已选/);
});
test('CSV/TSV supports BOM, quoted names, optional layers and manual assignment; malformed scores fail',()=>{
  const input=lib.parseRosterText('\uFEFF班级,参与姓名,前测成绩,层级,agentId\r\n一班,"张,三",0,低,A');
  assert.equal(input[0].fullName,'张,三');assert.equal(input[0].score,0);assert.equal(input[0].agentId,'A');
  assert.equal(lib.parseRosterText('班级\t姓名\t成绩\n一班\t甲\t10')[0].score,10);
  assert.throws(()=>lib.parseRosterText('班级,姓名,成绩\n一班,甲,'),/缺少/);
  assert.throws(()=>lib.parseRosterText('班级,姓名,成绩\n一班,"甲,10'),/引号/);
  assert.throws(()=>lib.parseRosterText('一班,甲,10'),/表头/);
  assert.match(lib.rosterCsv([['=formula','+value','normal',3]]),/"'=formula","'\+value","normal","3"/);
});
