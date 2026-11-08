import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const source=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
async function setup(extra={}){
 const nodes=new Map();const node=k=>{if(!nodes.has(k))nodes.set(k,{innerHTML:'',textContent:'',value:'',disabled:false,dataset:{},querySelectorAll:()=>[],querySelector:s=>node('#chat-form '+s),requestSubmit:()=>node('#chat-form').onsubmit({preventDefault(){}}),classList:{add(){},remove(){}}});return nodes.get(k);};
 const store=new Map([['sql-identity',JSON.stringify({id:'test',token:'fake-session'})],['local-key','fake-local']]);const timers=[],calls=[];
 let state={id:'test',name:'测试',class_code:'计网2543',server_now:Date.now()/1000,mode:'demo',tasks:[],rounds:[],meta_spec:{instruction:'请按实际情况作答',options:['非常不同意','不同意','既不同意也不反对','同意','非常同意']},gates:{pretest:{open:false,reason:'教师暂未开放'},meta_pre:{open:false,reason:'教师暂未开放'}}};
 state={...state,...extra};
 const context={document:{querySelector:node,querySelectorAll:()=>[]},location:{hash:'',pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},URLSearchParams,Date,JSON,Promise,console,setInterval:(fn,ms)=>timers.push({fn,ms}),setTimeout(){},requestAnimationFrame:fn=>fn(),clearTimeout(){},fetch:async(path,opts)=>{calls.push({path,opts});return {ok:true,json:async()=>path.includes('/api/questions?kind=posttest')?Array.from({length:10},(_,i)=>({text:'单选题'+(i+1),options:['甲','乙','丙','丁']})):path.includes('/api/questions?kind=meta')?Array.from({length:13},(_,i)=>'问卷题'+(i+1)):JSON.parse(JSON.stringify(state))};}};
 vm.runInNewContext(source,context);await new Promise(resolve=>setImmediate(resolve));
 return {node,calls,openQuiz:()=>context.navigate('quiz0'),quizBody:()=>context.quizBody(),saveQuiz:()=>context.saveQuiz(),openPretest:()=>context.navigate('pretest'),openMeta:()=>context.navigate('meta_pre'),openAI:()=>context.navigate('ai0'),poll:()=>timers.find(t=>t.ms===3000).fn(),open:()=>{state.gates.pretest={open:true,reason:'已开放'};}};
}
test('an already logged-in student sees a newly opened pretest without reloading',async()=>{const h=await setup();assert.match(h.node('#app').innerHTML,/data-go="pretest" disabled/);h.open();await h.poll();assert.doesNotMatch(h.node('#app').innerHTML,/data-go="pretest" disabled/);assert.match(h.node('#app').innerHTML,/已开放/);});
test('manual refresh synchronizes classroom state through the authenticated endpoint',async()=>{const h=await setup();h.open();await h.node('#refresh-classroom').onclick();assert.ok(h.calls.some(c=>c.path==='/api/refresh'&&c.opts.method==='POST'));assert.doesNotMatch(h.node('#app').innerHTML,/data-go="pretest" disabled/);assert.equal(h.node('#toast').textContent,'课堂安排已同步');});

test('horizontal questionnaire retains thirteen independent five-point radio groups',async()=>{const h=await setup();await h.openMeta();await new Promise(resolve=>setImmediate(resolve));const html=h.node('#app').innerHTML;assert.equal((html.match(/class="likert-options"/g)||[]).length,13);assert.equal((html.match(/type="radio"/g)||[]).length,65);for(let i=0;i<13;i++)for(let v=1;v<=5;v++)assert.ok(html.includes(`name="q${i}" value="${v}"`));});

const task={title:'示例项目',pages:'正文',brief:'示例任务'};
test('student workspace removes sidebar and opens only the current lesson',async()=>{const h=await setup({tasks:[task,task,task]});const html=h.node('#app').innerHTML;assert.doesNotMatch(html,/<aside|本机自动保存|三次正式课堂|可教智能体 · 课堂学习空间/);assert.equal((html.match(/data-lesson="[0-2]" open/g)||[]).length,1);});
test('Enter sends once while Shift+Enter and IME composition preserve text',async()=>{const h=await setup({mode:'real',tasks:[task],rounds:[{task,phase:'teaching',teaching_deadline:Date.now()/1000+900,messages:[{role:'assistant',content:'老师好'}],requests:[],limits:{max_questions:6}}]});await h.openAI();let submits=0,prevented=0;h.node('#chat-form').requestSubmit=()=>submits++;const key=(props={})=>h.node('#chat-text').onkeydown({key:'Enter',preventDefault(){prevented++;},...props});key({shiftKey:true});key({isComposing:true});key({keyCode:229});assert.equal(submits,0);key();assert.equal(submits,1);assert.equal(prevented,1);assert.match(h.node('#messages').innerHTML,/学徒头像/);assert.doesNotMatch(h.node('#app').innerHTML,/你的解释会自动保存|id="attach-image"/);assert.match(h.node('#app').innerHTML,/支持粘贴截图/);assert.match(h.node('#messages').innerHTML,/class="chat-person-name"/);assert.doesNotMatch(h.node('#messages').innerHTML,/<b>/);});

test('legacy count limits never disable sending during the teaching window',async()=>{const h=await setup({mode:'real',tasks:[task],rounds:[{task,phase:'teaching',teaching_deadline:Date.now()/1000+900,messages:[],requests:Array.from({length:25},()=>({status:'completed'})),limits:{max_questions:6}}]});await h.openAI();assert.equal(h.node('#chat-form button[type=submit]').disabled,false);});

test('four lessons display preparation first with identical student-facing stages before assignment',async()=>{
 const tasks=[{...task,title:'查询中的常用处理'},{...task,title:'聚合与分组'},{...task,title:'子查询比较'},{...task,title:'简单查询'}];
 const h=await setup({tasks,course_order:[3,0,1,2],next_lesson:3,has_pretest:true,has_meta_pre:true,group_assigned:false,gates:{ai3:{open:true,reason:'已开放'}}});
 const html=h.node('#app').innerHTML;
 assert.equal((html.match(/data-lesson=/g)||[]).length,4);
 assert.ok(html.indexOf('data-lesson="3"')<html.indexOf('data-lesson="0"'));
 assert.match(html,/data-go="ai3"\s*>进入/);
 assert.doesNotMatch(html,/准备阶段|正式干预|正式第|等待分组/);
 assert.match(html,/第 1 课/);assert.match(html,/第 4 课/);
 assert.equal((html.match(/教虚拟学徒/g)||[]).length,4);
 assert.equal((html.match(/SQL Server 独立实操/g)||[]).length,4);
 assert.equal((html.match(/当节课后测/g)||[]).length,4);
});

test('immediate posttest uses ten independent four-option questions and submits without SQL fields',async()=>{
 const h=await setup({tasks:[task],rounds:[{index:0,task,phase:'quiz',quiz_start:1,quiz_deadline:Date.now()/1000+600,quiz_format:'single_choice'}]});
 await h.openQuiz();await new Promise(resolve=>setImmediate(resolve));
 const html=h.node('#app').innerHTML;
 assert.equal((html.match(/class="mcq-question"/g)||[]).length,10);
 assert.equal((html.match(/class="mcq-options"/g)||[]).length,10);
 assert.equal((html.match(/type="radio"/g)||[]).length,40);
 assert.match(html,/每题10分/);assert.doesNotMatch(html,/textarea|SQL 编写题/);
 for(let i=0;i<10;i++)assert.match(html,new RegExp(`name="q${i}"`));
 const form=h.node('#quiz-form');form.dataset={count:'10',sqlCount:'0',key:'test-quiz'};
 form.elements=Object.fromEntries(Array.from({length:10},(_,i)=>['q'+i,{value:i?'':'A'}]));
 const body=h.quizBody();assert.equal(body.answers.length,10);assert.equal(body.answers[0],'A');assert.ok(!('sql_answers' in body));
 await h.saveQuiz();const save=h.calls.find(c=>c.opts?.body?.includes('quiz_draft'));
 assert.equal(JSON.parse(save.opts.body).answers.length,10);assert.ok(!('sql_answers' in JSON.parse(save.opts.body)));
});
