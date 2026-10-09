import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(await readFile('lib/entry-links.ts','utf8'), {
  compilerOptions: { module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022 },
}).outputText;
const links = {};
vm.runInNewContext(source,{ exports:links });

test('classroom short codes accept case and separator variations while retaining legacy links', () => {
  for (const input of ['abcd-2345','ABCD-2345','abcd2345',' ABCD2345 ']) assert.equal(links.normalizeEntryToken(input),'abcd-2345');
  assert.equal(links.normalizeEntryToken('1234567890abcdef1234567890abcdef'),'1234567890abcdef1234567890abcdef');
  for (const input of ['abc','abcd0123','abcdI234','abcdo234','x'.repeat(200),'<script>']) assert.equal(links.normalizeEntryToken(input),null);
});

test('one clipboard invitation contains the correct experiment, group, agents and exact link', () => {
  const invitation = links.buildEntryInvitation({ experimentName:'实验一',groupName:'B组',assignmentMode:'fixed',agentNames:['阅读助手B'],url:'https://school.example/join/abcd-2345' });
  assert.equal(invitation,'实验：实验一\n分组：B组\n智能体：阅读助手B\n分配方式：固定智能体\n实验链接：https://school.example/join/abcd-2345');
  const random = links.buildEntryInvitation({ experimentName:'实验二',groupName:'随机组',assignmentMode:'balanced_random',agentNames:['助手A','助手B'],url:'https://school.example/join/qrst-6789' });
  assert.ok(random.includes('助手A、助手B'));
  assert.ok(random.includes('均衡随机分配'));
});
