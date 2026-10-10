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

test('four-character classroom codes accept case variations and retain historical links', () => {
  for (const input of ['abcd','ABCD',' ABCD ']) assert.equal(links.normalizeEntryToken(input),'abcd');
  for (const input of ['abcd-2345','ABCD-2345','abcd2345',' ABCD2345 ']) assert.equal(links.normalizeEntryToken(input),'abcd-2345');
  assert.equal(links.normalizeEntryToken('1234567890abcdef1234567890abcdef'),'1234567890abcdef1234567890abcdef');
  for (const input of ['abc','abcde','ab01','abIl','abOo','abcd0123','abcdI234','abcdo234','x'.repeat(200),'<script>']) assert.equal(links.normalizeEntryToken(input),null);
});

test('clipboard invitation contains only the identifying name and exact link, with no experimental conditions', () => {
  const invitation = links.buildEntryInvitation({ label:'助手B',url:'https://school.example/join/abcd' });
  assert.equal(invitation,'助手B\nhttps://school.example/join/abcd');
  assert.equal(invitation.split('\n').length,2);
  assert.doesNotMatch(invitation,/实验：|分组：|智能体：|分配方式|固定|均衡|随机/);
});

test('four-character allocation retries collisions and one-character neighbors under the shared lock', async () => {
  const events = [];
  const sequence = [...'abcdabceqrst'];
  const tokenSource = ts.transpileModule(await readFile('lib/entry-token.ts','utf8'), {
    compilerOptions: { module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 },
  }).outputText;
  const tokens = {};
  const modules = { 'server-only':{}, '@/lib/entry-links':links,
    'node:crypto':{ randomInt:() => links.ENTRY_CODE_ALPHABET.indexOf(sequence.shift()) } };
  vm.runInNewContext(tokenSource,{ exports:tokens,require:name => modules[name] });
  const token = await tokens.createRunEntryToken({ query:async sql => {
    events.push(sql);
    return { rows:sql.includes('SELECT entry_token') ? [{ entry_token:'abcd',blocked:true }] : [] };
  } });
  assert.equal(token,'qrst');
  assert.match(events[0],/pg_advisory_xact_lock/);
  assert.match(events[1],/length\(entry_token\)=4/);
});
