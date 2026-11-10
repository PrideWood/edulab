import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import ts from 'typescript';import {readFile} from 'node:fs/promises';import {z} from 'zod';import * as crypto from 'node:crypto';
const code=async path=>ts.transpileModule(await readFile(path,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const display={};vm.runInNewContext(await code('lib/sql-study-display.ts'),{exports:display});
const policy={};vm.runInNewContext(await code('lib/sql-study-policy.ts'),{exports:policy,require:n=>n==='zod'?{z}:n.endsWith('sql-study-display')?display:crypto});const routeSource=await code('app/api/admin/sql-study/route.ts');
const cfg=JSON.parse(await readFile('lib/sql-study-defaults.json','utf8'));
class ApiError extends Error{constructor(status,code,message){super(message);this.status=status;this.code=code;}}
function setup(auth=true,records=[],grades=[]){let writes=0,reads=0;const route={};const control={selectSqlTestLesson:async()=>{writes++;return {ok:true};},getSqlDashboard:async()=>{reads++;return {revision:1,config:cfg,records,grades,researchAssessments:[],assignments:[],balance:[]};},getSqlControl:async()=>({config:cfg}),saveSqlControl:async()=>{writes++;return {ok:true};},assignSqlClass:async()=>{writes++;return {assigned:2};},gradeSql:async()=>{writes++;return {ok:true};}};
 const deps={'@/lib/sql-study-research':{getPaperMaterial:async kind=>kind==='student'?'学生卷':'教师卷',saveResearchAssessment:async()=>{writes++;return {ok:true};},exportEnaMessages:()=> 'anon',exportResearchMeasures:()=> 'anon'},'zod':{z},'@/lib/admin-auth':{getAuthenticatedAdmin:async()=>auth?{id:'admin'}:null,assertSameOrigin:r=>{if(r.headers.get('origin')!==new URL(r.url).origin)throw new ApiError(403,'ORIGIN','invalid');}},'@/lib/http':{ApiError,errorResponse:e=>Response.json({error:{message:e.message}},{status:e.status??500})},'@/lib/sql-study-control':control,'@/lib/sql-study-policy':policy,'@/lib/shared-model':{getSharedModelSummary:async()=>({hasToken:false})},'@/lib/deepseek':{DeepSeekError:class extends Error{}}};
 vm.runInNewContext(routeSource,{exports:route,require:n=>{if(n in deps)return deps[n];throw Error(n);},Response,URL,AbortSignal});
 return {route,reads:()=>reads,writes:()=>writes,post:(body,origin='http://localhost')=>route.POST(new Request('http://localhost/api/admin/sql-study',{method:'POST',headers:{'Content-Type':'application/json',origin},body:JSON.stringify(body)}))};}
test('all SQL data formats require an existing admin before any read',async()=>{const h=setup(false);for(const format of ['','groups','timings','full','questionnaire','combined','pretest','posttests','ena','research','d1_student','d1_teacher'])assert.equal((await h.route.GET(new Request('http://localhost/api/admin/sql-study?format='+format))).status,401);assert.equal(h.reads(),0);});
test('cloud saves, grading and assignment reject missing sessions, bad origins and malformed actions before writes',async()=>{let h=setup(false);assert.equal((await h.post({action:'save',revision:1,config:cfg})).status,401);assert.equal(h.writes(),0);h=setup();assert.equal((await h.post({action:'save',revision:1,config:cfg},'http://evil.test')).status,403);assert.equal((await h.post({action:'grade',deviceId:'invalid',lesson:0,scores:[100]})).status,400);assert.equal(h.writes(),0);});
test('cloud full export is a private attachment with separate authoritative grading and grouping',async()=>{const h=setup();const response=await h.route.GET(new Request('http://localhost/api/admin/sql-study?format=full'));assert.equal(response.status,200);assert.match(response.headers.get('content-disposition'),/attachment/);assert.match(response.headers.get('cache-control'),/private/);const d=await response.json();assert.ok(Array.isArray(d.grades));assert.ok(Array.isArray(d.assignments));assert.equal(d.study,'sql-teachable-mvp/1');});
test('saved demo prompt debug remains separate from student writes',async()=>{const h=setup();const response=await h.post({action:'debug',lesson:0,text:'我会先选择表中的姓名列。'});const d=await response.json();assert.equal(d.results.length,2);assert.equal(d.mode,'demo');assert.equal(h.writes(),0);});

test('questionnaire and combined exports retain composite IDs, missing states and item scores without merging names',async()=>{
 const records=['device-a','device-b'].map((device_id,i)=>({device_id,participant_id:'student-'+i,participant_name:'同名测试',class_code:'计网2541',is_test:true,received_at:'2026-11-08',archive:{participant:{id:'student-'+i},study:{id:'student-'+i,group:null,pretest:{score:50,answers:['A']},meta_pre:i?null:{answers:Array(13).fill(4),monitoring:4,evaluation:4,version:'test-v1'},meta_post:null,rounds:[]}}}));
 const h=setup(true,records);
 for(const format of ['questionnaire','combined','pretest']){const response=await h.route.GET(new Request('http://localhost/api/admin/sql-study?format='+format));assert.equal(response.status,200);const text=await response.text();assert.ok(text.includes('device-a:student-0'));assert.ok(text.includes('device-b:student-1'));if(format!=='pretest'){assert.match(text,/未提交/);assert.match(text,/M01/);assert.match(text,/test-v1/);}}
 records[0].archive.study.id='wrong';assert.equal((await h.route.GET(new Request('http://localhost/api/admin/sql-study?format=combined'))).status,409);
});

test('choice posttest exports keep ten answers, question snapshots and automatic totals separate from grading',async()=>{
 const record={device_id:'device',participant_id:'student',participant_name:'测试',class_code:'计网2543',is_test:true,archive:{participant:{id:'student'},study:{scheme_version:'business-workorders/1',id:'student',pretest:{score:50},rounds:[{scheme_version:'business-workorders/1',index:0,phase:'done',quiz:{format:'single_choice',version:'textbook-single-choice/1',score:80,mcq_score:80,question_count:10,correct:8,max_score:100,answers:Array(10).fill('B'),elapsed_seconds:120,items:[{id:'L2Q01',text:'题目快照'}]}}]}}};
 const h=setup(true,[record],[{device_id:'device',participant_id:'student',lesson:0,scores:[20,20]}]);
 const response=await h.route.GET(new Request('http://localhost/api/admin/sql-study?format=posttests'));
 assert.equal(response.status,200);const csv=await response.text();assert.match(csv,/Q10/);assert.match(csv,/题目快照/);assert.match(csv,/textbook-single-choice\/1/);
 const combined=await (await h.route.GET(new Request('http://localhost/api/admin/sql-study?format=combined'))).text();
 const parse=line=>Array.from(line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g),m=>m[1].replaceAll('""','"'));
 const [headers,row]=combined.trim().replace(/^\uFEFF/,'').split('\r\n').map(parse);
 assert.equal(row[headers.indexOf('正式第1课_后测总分')],'80');
 assert.equal(row[headers.indexOf('正式第1课_SQL题1得分')],'');assert.equal(h.writes(),0);
});

test('test lesson commands require admin, same origin and a valid four-lesson identity payload',async()=>{
 const body={action:'select_test_lesson',deviceId:'7ee99094-b337-4a64-9c61-acd3ba784321',participantId:'46ec9456-d3c6-4a24-b931-5229027d6211',lesson:3};
 const denied=setup(false);assert.equal((await denied.post(body)).status,401);assert.equal(denied.writes(),0);
 const h=setup();assert.equal((await h.post(body,'http://other.test')).status,403);assert.equal((await h.post({...body,lesson:5})).status,400);assert.equal(h.writes(),0);
 assert.equal((await h.post(body)).status,200);assert.equal(h.writes(),1);
});

test('paper materials require admin and are private attachments without roster reads',async()=>{const denied=setup(false);assert.equal((await denied.route.GET(new Request('http://localhost/api/admin/sql-study?format=d1_teacher'))).status,401);const h=setup();for(const [format,text] of [['d1_student','学生卷'],['d1_teacher','教师卷']]){const r=await h.route.GET(new Request('http://localhost/api/admin/sql-study?format='+format));assert.equal(r.status,200);assert.equal(await r.text(),text);assert.match(r.headers.get('cache-control'),/private, no-store/);assert.match(r.headers.get('content-disposition'),/attachment/);}assert.equal(h.reads(),0);});
