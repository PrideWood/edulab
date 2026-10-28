import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const exports={};
vm.runInNewContext(ts.transpileModule(await readFile('lib/local-backup-download.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});
const download=exports.downloadLocalBackupBatches;
const records=Array.from({length:551},(_,i)=>({deviceId:'ABC',participantId:String(i)}));
const zip=n=>new Response('zip',{headers:{'Content-Type':'application/zip','X-EduLab-Export-Count':String(n)}});
test('all selected participants export once in bounded batches',async()=>{
 const requested=[],saved=[];const result=await download([...records,records[0]],{request:async rows=>{requested.push(...rows);assert.ok(rows.length<=500);return zip(rows.length);},save:blob=>saved.push(blob)});
 assert.equal(result.count,551);assert.equal(result.files,2);assert.equal(saved.length,2);assert.equal(new Set(requested.map(r=>r.participantId)).size,551);assert.equal(requested[0].deviceId,'abc');assert.deepEqual(requested.map(r=>r.exportIndex),Array.from({length:551},(_,i)=>i+1));
});
test('large ZIPs split without losing participants',async()=>{
 let count=0;const indices=[];const result=await download(records.slice(0,7),{request:async rows=>{if(rows.length>2)return new Response('',{status:413});indices.push(...rows.map(r=>r.exportIndex));return zip(rows.length);},save:()=>count++});assert.equal(result.count,7);assert.equal(count,4);assert.deepEqual(indices,[1,2,3,4,5,6,7]);
});
test('single oversized archive terminates and reports partial completion',async()=>{
 await assert.rejects(download(records.slice(0,2),{request:async rows=>rows.length===2||rows[0].participantId==='1'?new Response('',{status:413}):zip(1),save:()=>{}}),error=>error.completedCount===1&&error.completedFiles===1&&/单条/.test(error.message));
});
test('invalid ZIP response and mismatched count never save a file',async()=>{
 for(const response of [new Response('html'),zip(9)]){
  let saved=false;await assert.rejects(download(records.slice(0,1),{request:async()=>response,save:()=>{saved=true;}}));assert.equal(saved,false);
 }
});
