import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const rawSource=await readFile(new URL('../web/app.js',import.meta.url),'utf8');
const source=process.env.SQL_STUDENT_CHROME69==='1'?(await import('../compile_browser.mjs')).compileChrome69(rawSource):rawSource;
async function setup(extra={},loggedIn=true){
 const nodes=new Map();const node=k=>{if(!nodes.has(k))nodes.set(k,{insertAdjacentHTML:(position,html)=>{node('#app').innerHTML+=html;},innerHTML:'',textContent:'',value:'',disabled:false,dataset:{},querySelectorAll:()=>[],querySelector:s=>node('#chat-form '+s),requestSubmit:()=>node('#chat-form').onsubmit({preventDefault(){}}),classList:{add(){},remove(){}}});return nodes.get(k);};
 const store=new Map([['sql-identity',JSON.stringify({id:'test',token:'fake-session'})],['local-key','fake-local']]);if(!loggedIn)store.delete('sql-identity');const timers=[],calls=[];
 let state={id:'test',name:'测试',class_code:'计网2543',server_now:Date.now()/1000,mode:'demo',tasks:[],rounds:[],meta_spec:{instruction:'请按实际情况作答',options:['非常不同意','不同意','既不同意也不反对','同意','非常同意']},gates:{pretest:{open:false,reason:'教师暂未开放'},meta_pre:{open:false,reason:'教师暂未开放'}}};
 state={...state,...extra};
 const context={document:{querySelector:node,querySelectorAll:()=>[]},location:{hash:'',pathname:'/'},history:{replaceState(){}},sessionStorage:{getItem:k=>store.get(k)??null,setItem:(k,v)=>store.set(k,v)},URLSearchParams,Date,JSON,Promise,console,setInterval:(fn,ms)=>timers.push({fn,ms}),setTimeout(){},requestAnimationFrame:fn=>fn(),clearTimeout(){},fetch:async(path,opts)=>{calls.push({path,opts});return {ok:true,json:async()=>path==='/api/classes'?{classes:state.classes??[{code:'2531',label:'2531'},{code:'2532',label:'2532'}]}:path.includes('/api/questions?kind=posttest')?Array.from({length:10},(_,i)=>({text:'单选题'+(i+1),options:['甲','乙','丙','丁']})):path.includes('/api/questions?kind=meta')?Array.from({length:13},(_,i)=>'问卷题'+(i+1)):JSON.parse(JSON.stringify(state))};}};
 vm.runInNewContext(source,context);await new Promise(resolve=>setImmediate(resolve));
 return {node,calls,change:next=>{state={...state,...next};},openQuiz:()=>context.navigate('quiz0'),quizBody:()=>context.quizBody(),saveQuiz:()=>context.saveQuiz(),openPretest:()=>context.navigate('pretest'),openMeta:()=>context.navigate('meta_pre'),openPractice:(i=0)=>context.navigate('practice'+i),openAI:(i=0)=>context.navigate('ai'+i),action:(...args)=>context.action(...args),poll:()=>timers.find(t=>t.ms===3000).fn(),open:()=>{state.gates.pretest={open:true,reason:'已开放'};}};
}
test('an already logged-in student sees a newly opened pretest without reloading',async()=>{const h=await setup();assert.match(h.node('#app').innerHTML,/data-go="pretest" disabled/);h.open();await h.poll();assert.doesNotMatch(h.node('#app').innerHTML,/data-go="pretest" disabled/);assert.match(h.node('#app').innerHTML,/已开放/);});
test('manual refresh synchronizes classroom state through the authenticated endpoint',async()=>{const h=await setup();h.open();await h.node('#refresh-classroom').onclick();assert.ok(h.calls.some(c=>c.path==='/api/refresh'&&c.opts.method==='POST'));assert.doesNotMatch(h.node('#app').innerHTML,/data-go="pretest" disabled/);assert.equal(h.node('#toast').textContent,'课堂安排已同步');});

test('horizontal questionnaire retains thirteen independent five-point radio groups',async()=>{const h=await setup();await h.openMeta();await new Promise(resolve=>setImmediate(resolve));const html=h.node('#app').innerHTML;assert.equal((html.match(/class="likert-options"/g)||[]).length,13);assert.equal((html.match(/type="radio"/g)||[]).length,65);for(let i=0;i<13;i++)for(let v=1;v<=5;v++)assert.ok(html.includes(`name="q${i}" value="${v}"`));});

const task={title:'示例项目',pages:'正文',brief:'示例任务'};
test('student workspace removes sidebar and opens only the current lesson',async()=>{const h=await setup({tasks:[task,task,task]});const html=h.node('#app').innerHTML;assert.doesNotMatch(html,/<aside|本机自动保存|三次正式课堂|可教智能体 · 课堂学习空间/);assert.equal((html.match(/data-lesson="[0-2]" open/g)||[]).length,1);});
test('Enter sends once while Shift+Enter and IME composition preserve text',async()=>{const h=await setup({mode:'real',tasks:[task],rounds:[{task,phase:'teaching',teaching_deadline:Date.now()/1000+900,messages:[{role:'assistant',content:'老师好'}],requests:[],limits:{max_questions:6}}]});await h.openAI();let submits=0,prevented=0;h.node('#chat-form').requestSubmit=()=>submits++;const key=(props={})=>h.node('#chat-text').onkeydown({key:'Enter',preventDefault(){prevented++;},...props});key({shiftKey:true});key({isComposing:true});key({keyCode:229});assert.equal(submits,0);key();assert.equal(submits,1);assert.equal(prevented,1);assert.match(h.node('#messages').innerHTML,/学徒头像/);assert.doesNotMatch(h.node('#app').innerHTML,/你的解释会自动保存|id="attach-image"/);assert.match(h.node('#app').innerHTML,/支持粘贴截图/);assert.match(h.node('#messages').innerHTML,/class="chat-person-name"/);assert.doesNotMatch(h.node('#messages').innerHTML,/<b>/);});

test('legacy count limits never disable sending during the teaching window',async()=>{const h=await setup({mode:'real',tasks:[task],rounds:[{task,phase:'teaching',teaching_deadline:Date.now()/1000+900,messages:[],requests:Array.from({length:25},()=>({status:'completed'})),limits:{max_questions:6}}]});await h.openAI();assert.equal(h.node('#chat-form button[type=submit]').disabled,false);});

test('shared preparation and four formal entries render before group assignment',async()=>{
 const tasks=Array.from({length:5},(_,i)=>({...task,title:'任务'+i}));
 const h=await setup({tasks,course_order:[4,0,1,2,3],next_lesson:4,has_pretest:true,has_meta_pre:true,group_assigned:false,gates:{ai4:{open:true,reason:'已开放'},ai0:{open:true}}});
 const html=h.node('#app').innerHTML;
 assert.equal((html.match(/data-lesson=/g)||[]).length,5);
 assert.ok(html.indexOf('data-lesson="4"')<html.indexOf('data-lesson="0"'));
 assert.doesNotMatch(html,/data-go="ai4" disabled/);assert.match(html,/data-go="ai0" disabled/);
 assert.match(html,/准备课P0/);assert.match(html,/正式第4课/);
 assert.doesNotMatch(html,/性别代码映射|三轮正式干预|分组试运行/);
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

test('a teacher test-lesson switch leaves stale chat and highlights the newly selected first class',async()=>{
 const tasks=[task,task,task,task];
 const h=await setup({is_test:true,tasks,course_order:[3,0,1,2],next_lesson:1,has_pretest:true,has_meta_pre:true,group_assigned:true,unavailable_lessons:[3],rounds:[{id:'old',index:0,task,phase:'teaching',teaching_deadline:Date.now()/1000+900,messages:[],requests:[]}]});
 assert.match(h.node('#app').innerHTML,/保留旧版课堂记录/);await h.openAI();
 h.change({rounds:[],next_lesson:3,unavailable_lessons:[],test_lesson_revision:'switch-id',gates:{ai3:{open:true,reason:'已开放'}}});
 await h.poll();
 const html=h.node('#app').innerHTML;
 assert.match(html,/data-lesson="3" open/);assert.match(html,/data-go="ai3"\s*>进入/);
 assert.doesNotMatch(html,/id="chat-form"/);
 const first=html.slice(html.indexOf('data-lesson="3"'),html.indexOf('data-lesson="0"'));
 assert.match(first,/当前课堂/);
});

test('suggested teaching time does not disable the composer or retry button',async()=>{const h=await setup({mode:'real',tasks:[task],rounds:[{index:0,task,phase:'teaching',teaching_deadline:Date.now()/1000-200,messages:[],requests:[{status:'failed'}],limits:{}}]});await h.openAI();assert.equal(h.node('#chat-form button[type=submit]').disabled,false);assert.equal(h.node('#chat-text').disabled,false);assert.equal(h.node('#retry-chat').disabled,false);assert.doesNotMatch(h.node('#chat-status').textContent,/时段已结束/);});


test('teacher opens a later lesson while an earlier lesson is unfinished',async()=>{
 const h=await setup({tasks:[task,task,task,task],course_order:[3,0,1,2],has_pretest:true,has_meta_pre:true,group_assigned:true,next_lesson:0,gates:{ai1:{open:true},ai2:{open:false}},rounds:[{id:'earlier',index:3,task,phase:'teaching',messages:[],requests:[]}]});
 assert.match(h.node('#app').innerHTML,/data-go="ai1"\s*>进入/);
 assert.match(h.node('#app').innerHTML,/data-go="ai2" disabled/);
 assert.doesNotMatch(h.node('#app').innerHTML,/请先完成当前课堂/);
});

test('actions and polling stay bound to displayed lesson rather than newest record',async()=>{
 const rounds=[{id:'chosen',index:0,task,phase:'teaching',messages:[],requests:[]},{id:'newest',index:1,task,phase:'teaching',messages:[],requests:[]}];
 const h=await setup({tasks:[task,task],rounds});await h.openAI(0);await h.action('draft',{sql:'SELECT 1'});
 const call=h.calls.find(c=>c.path==='/api/action');assert.equal(JSON.parse(call.opts.body).round_id,'chosen');
 h.change({rounds:[rounds[0],{...rounds[1],phase:'done'}]});await h.poll();
 assert.match(h.node('#app').innerHTML,/id="chat-form"/);
});


test('teacher may open practice and posttest without an AI round',async()=>{
 const h=await setup({tasks:[task],rounds:[],has_pretest:true,has_meta_pre:true,group_assigned:true,gates:{ai0:{open:false},practice0:{open:true},posttest0:{open:true}}});
 const html=h.node('#app').innerHTML;assert.match(html,/data-go="practice0"\s*>进入/);assert.match(html,/data-go="quiz0"\s*>进入/);assert.match(html,/data-go="ai0" disabled/);
 await h.openPractice();assert.match(h.node('#app').innerHTML,/开始计时并实操/);assert.doesNotMatch(h.node('#app').innerHTML,/请先完成本课/);
 await h.openQuiz();assert.match(h.node('#app').innerHTML,/id="start-quiz"/);
});

test('submitted quiz remains complete when other stages change the lesson phase',async()=>{
 const h=await setup({tasks:[task],has_pretest:true,has_meta_pre:true,group_assigned:true,gates:{ai0:{open:true},posttest0:{open:true}},rounds:[{id:'mixed',index:0,task,phase:'practice',teaching_started:true,teaching_deadline:1,practice_started:true,quiz_started:true,quiz_completed:true,messages:[],requests:[]}]});
 assert.match(h.node('#app').innerHTML,/data-go="quiz0" disabled>已完成/);
 await h.openAI();assert.match(h.node('#app').innerHTML,/id="chat-form"/);
});

 test('login dropdown follows cloud classes and preserves typed identity before entry',async()=>{const h=await setup({},false);assert.match(h.node('#app').innerHTML,/value="2531"/);assert.doesNotMatch(h.node('#app').innerHTML,/2541|2542|2543/);h.node('#login-form input').value='尚未登录';h.node('#login-form select').value='2531';h.change({classes:[{code:'2531',label:'2531'},{code:'2533',label:'新增<&班'}]});await h.poll();assert.match(h.node('#app').innerHTML,/value="2533"/);assert.match(h.node('#app').innerHTML,/新增&lt;&amp;班/);assert.equal(h.node('#login-form input').value,'尚未登录');assert.equal(h.node('#login-form select').value,'2531');assert.ok(!h.calls.some(c=>c.path==='/api/enter'));});

test('grouped P0 waits for assignment and shows no minimum word counter',async()=>{const tasks=[task,task,task,task,task];const h=await setup({tasks,course_order:[4,0,1,2,3],preparation_grouped:true,has_pretest:true,has_meta_pre:true,group_assigned:false,gates:{ai4:{open:false,reason:'请先分组'}}});assert.match(h.node('#app').innerHTML,/请等待教师完成前测分组/);assert.doesNotMatch(h.node('#app').innerHTML,/至少.{0,3}字/);});
test('mental-effort card has nine unselected options and required submission',async()=>{const h=await setup({prediction_enabled:true,tasks:[task],rounds:[{id:'r',index:0,task,phase:'teaching',teaching_deadline:Date.now()/1000-1,messages:[],requests:[],dialogue:{completed_turns:12,max_turns:12,closed:true,window_ended:true,can_send:false,effort_due:true}}]});await h.openAI();const html=h.node('#research-controls').innerHTML;assert.equal((html.match(/type="radio"/g)||[]).length,9);assert.doesNotMatch(html,/checked/);assert.doesNotMatch(html,/暂不回答|skip-effort/);assert.match(html,/required/);assert.equal(h.node('#chat-form button[type=submit]').disabled,true);});
test('practice removes score prediction without exposing teacher assessment',async()=>{const h=await setup({prediction_enabled:true,tasks:[task],rounds:[{id:'r',index:0,task,phase:'practice',practice_deadline:Date.now()/1000+100,messages:[],requests:[],draft:{sql:'',result:'',note:''},dialogue:{closed:true,effort_done:true}}]});await h.openPractice();const html=h.node('#app').innerHTML;assert.doesNotMatch(html,/predicted_score|预估分|估算/);assert.doesNotMatch(html,/value="50"|value="100"/);});

test('current-task home displays exactly the selected lesson',async()=>{const h=await setup({access_policy:'current-task/1',current_lesson:2,tasks:Array.from({length:5},()=>task),course_order:[4,0,1,2,3]});const html=h.node('#app').innerHTML;assert.equal((html.match(/data-lesson=/g)||[]).length,1);assert.match(html,/data-lesson="2"/);await h.openAI(0);assert.match(h.node('#app').innerHTML,/当前任务已更新/);});

test('classroom API explicitly preserves same-origin browser headers',async()=>{const h=await setup();h.open();await h.node('#refresh-classroom').onclick();const call=h.calls.find(c=>c.path==='/api/refresh');assert.equal(call.opts.mode,'same-origin');assert.equal(call.opts.referrerPolicy,'same-origin');});

test('nine successful turns cannot end; ten enables voluntary finish without time gate',async()=>{const r={id:'minimum',index:0,task,phase:'teaching',teaching_deadline:Date.now()/1000+1200,messages:[],requests:[],dialogue:{completed_turns:9,minimum_turns:10,max_turns:null,closed:false,pending:false,can_send:true,can_finish:false}};const h=await setup({tasks:[task],rounds:[r]});await h.openAI();assert.match(h.node('#research-controls').innerHTML,/还需完成 1 轮有效对话/);assert.match(h.node('#research-controls').innerHTML,/disabled/);h.change({rounds:[{...r,dialogue:{...r.dialogue,completed_turns:10,can_finish:true}}]});await h.poll();const html=h.node('#research-controls').innerHTML;assert.match(html,/结束对话，填写结束卡/);assert.doesNotMatch(html,/id="finish-dialogue"[^>]*disabled/);assert.match(html,/无上限/);});
test('student sees confirmed cloud receipt separately from pending local backup',async()=>{const h=await setup({backup:{status:'queued',pending:1,error:null}});assert.match(h.node('#backup-status').textContent,/正在同步/);h.change({backup:{status:'uploaded',pending:0}});await h.poll();assert.equal(h.node('#backup-status').textContent,'进度已同步 · 云端归档完成');});

test('formal home hides final questionnaire before last lesson',async()=>{const h=await setup({access_policy:'current-task/1',current_lesson:0,is_test:false,tasks:[task,task,task,task,task]});assert.doesNotMatch(h.node('#app').innerHTML,/data-go="meta_post"/);});
test('formal last lesson displays final questionnaire in its own course',async()=>{const h=await setup({access_policy:'current-task/1',current_lesson:3,is_test:false,tasks:[task,task,task,task,task]});assert.match(h.node('#app').innerHTML,/data-go="meta_post"/);});
test('test home displays all lessons and optional questionnaires',async()=>{const gates={pretest:{open:true},meta_pre:{open:true},meta_post:{open:true}};for(let i=0;i<5;i++)for(const stage of ['ai','practice','posttest'])gates[stage+i]={open:true};const h=await setup({access_policy:'current-task/1',current_lesson:4,is_test:true,has_pretest:false,has_meta_pre:false,group_assigned:true,tasks:[task,task,task,task,task],gates});const html=h.node('#app').innerHTML;for(let i=0;i<5;i++)assert.match(html,new RegExp('data-go="ai'+i+'"[^>]*>进入'));assert.match(html,/data-go="meta_post"/);assert.match(html,/前测和问卷可跳过/);});

test('practice screenshot entry preserves required SQL fields and is optional for tests',async()=>{const h=await setup({is_test:true,tasks:[task],rounds:[{id:'round-images',index:0,task,phase:'practice',practice_start:1,practice_deadline:9999999999,draft:{sql:'SELECT 1',result:'1',note:'核验'},practice_images:[]}]});await h.openPractice();const html=h.node('#app').innerHTML;assert.match(html,/本人运行结果截图/);assert.match(html,/测试账号可不上传/);assert.match(html,/id="practice-image-file"/);assert.equal((html.match(/<textarea[^>]*required/g)||[]).length,3);assert.match(html,/data-round-id="round-images"/);});
test('a pending screenshot prevents the cloud archive completion label',async()=>{const h=await setup({backup:{pending:1,pending_images:1,status:'queued',last_uploaded_epoch:10}});assert.match(h.node('#backup-status').textContent,/待传截图 1 张/);assert.doesNotMatch(h.node('#backup-status').textContent,/云端归档完成/);});
