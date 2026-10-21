import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const exports={};
vm.runInNewContext(ts.transpileModule(await readFile('lib/transcript-export.ts','utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText,{exports});
const {buildTranscriptExport,includeBrowserTranscriptBackups}=exports;
const experiment={id:'project',label:'课堂实验',title:'学习任务',assistantName:'AI',welcome:''};
const message=(sequenceNo,content)=>({id:`m-${sequenceNo}`,status:'completed',sequenceNo,turnIndex:1,
  role:sequenceNo%2?'user':'assistant',content,sentAt:'2026-10-21T01:00:00.000Z',replyStartedAt:null,replyCompletedAt:null,
  latencyMs:null,clientRequestId:'request',cozeMessageId:null,cozeChatId:null});
function record(id,enabled,messages=[]) {
  const transcript=buildTranscriptExport({exportedAt:'2026-10-21T02:00:00.000Z',experiment,databaseMessagesEnabled:enabled,browserBackupIncluded:false,messages,
    session:{id,status:'completed',startedAt:'2026-10-21T01:00:00.000Z',lastActivityAt:'2026-10-21T01:10:00.000Z',participantCode:'P001',cozeConversationId:null,experimentRunId:'group',agentId:'agent'}});
  return {...transcript,title:id,completedAt:'2026-10-21T01:10:00.000Z',interaction:{id,previousSessionId:null},
    integrity:{...transcript.integrity,requestCount:1,pending:false,possiblyIncomplete:!enabled}};
}
function archive(conversations) {
  return {schemaVersion:1,type:'participant-interaction-archive',source:'database',exportedAt:'2026-10-21T02:00:00.000Z',
    participant:{code:'P001'},experimentId:'project',experimentRunId:'group',currentSessionId:conversations.at(-1).session.id,
    integrity:{sessionCount:conversations.length,messageCount:conversations.reduce((sum,row)=>sum+row.messages.length,0),
      possiblyIncompleteSessionCount:conversations.filter(row=>row.integrity.possiblyIncomplete).length},conversations};
}

test('all-session downloads preserve authoritative database messages without substituting browser history',()=>{
  const input=archive([record('lesson-1',true,[message(1,'first'),message(2,'answer')]),record('lesson-2',true)]);
  const result=includeBrowserTranscriptBackups(input,experiment,()=>{throw new Error('database session must not read browser content');});
  assert.equal(result.conversations.length,2);assert.equal(result.integrity.messageCount,2);
  assert.equal(result.source,'database');assert.equal(result.conversations[1].messages.length,0);
  assert.equal(result.conversations[0].messages[0].content,'first');
});

test('explicitly browser-only sessions supplement local records in order while database copies win duplicates',()=>{
  const input=archive([record('lesson-1',false,[message(1,'confirmed')]),record('lesson-2',true)]);
  const read=[];
  const result=includeBrowserTranscriptBackups(input,experiment,id=>{read.push(id);return [message(2,'local answer'),message(1,'stale browser question')];});
  assert.deepEqual(read,['lesson-1']);assert.equal(result.source,'database_and_browser');
  assert.deepEqual(Array.from(result.conversations[0].messages,message=>message.content),['confirmed','local answer']);
  assert.deepEqual(Array.from(result.conversations[0].messages,message=>message.order),[1,2]);
  assert.equal(result.conversations[0].integrity.turnCount,1);
  assert.equal(result.conversations[0].storage.browserBackupIncluded,true);
  assert.equal(result.integrity.messageCount,2);assert.equal(result.integrity.possiblyIncompleteSessionCount,1);
  assert.equal(input.conversations[0].messages.length,1);assert.equal(input.source,'database');
});

test('missing browser-only history remains explicitly incomplete instead of fabricating an empty completed transcript',()=>{
  const result=includeBrowserTranscriptBackups(archive([record('other-device-lesson',false)]),experiment,()=>[]);
  assert.equal(result.integrity.possiblyIncompleteSessionCount,1);
  assert.equal(result.conversations[0].integrity.possiblyIncomplete,true);
  assert.equal(result.conversations[0].storage.browserBackupIncluded,false);
  assert.equal(result.integrity.messageCount,0);
});
