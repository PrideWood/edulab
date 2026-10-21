import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';
const exports = {};
vm.runInNewContext(ts.transpileModule(await readFile('lib/composer-draft.ts','utf8'), {
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
}).outputText, {exports});
const {reconcileComposerDraft: reconcile} = exports;
const draft = (overrides={}) => ({sessionId:'session-a',text:'',savedText:'已发送的问题',revision:1,conflict:true,...overrides});

test('server-cleared empty draft clears stale conflict and adopts send revision', () => {
  const next=reconcile(draft(),{text:'',revision:2},true);
  assert.equal(next.conflict,false); assert.equal(next.revision,2); assert.equal(next.savedText,'');
  // Typing the next question must not remain blocked by the previous conflict.
  const typed=reconcile({...next,text:'下一句'},{text:'',revision:2},false);
  assert.equal(typed.conflict,false); assert.equal(typed.text,'下一句');
});
test('confirmed send rebases without deleting a newly typed question', () => {
  const next=reconcile(draft({text:'下一句'}),{text:'',revision:2},true);
  assert.equal(next.text,'下一句'); assert.equal(next.savedText,''); assert.equal(next.conflict,false);
});
test('unconfirmed send never bypasses a real revision conflict', () => {
  const next=reconcile(draft({text:'本机草稿',conflict:false}),{text:'',revision:2},false);
  assert.equal(next.text,'本机草稿'); assert.equal(next.conflict,true); assert.equal(next.revision,1);
});
test('different nonempty remote draft remains protected even with a confirmed send', () => {
  const next=reconcile(draft({text:'本机草稿'}),{text:'另一设备草稿',revision:3},true);
  assert.equal(next.text,'本机草稿'); assert.equal(next.conflict,true);
});
test('equal draft content resolves the conflict without another save', () => {
  const next=reconcile(draft({text:'相同内容'}),{text:'相同内容',revision:4},false);
  assert.equal(next.conflict,false); assert.equal(next.savedText,'相同内容'); assert.equal(next.revision,4);
});
test('unchanged remote revision preserves unsaved local edits', () => {
  const next=reconcile(draft({text:'未发送',conflict:false}),{text:'已发送的问题',revision:1},false);
  assert.equal(next.text,'未发送'); assert.equal(next.conflict,false); assert.equal(next.savedText,'已发送的问题');
});
