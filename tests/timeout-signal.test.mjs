import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(await readFile('lib/timeout-signal.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText;

function load(signalClass) {
  const exports = {};
  vm.runInNewContext(source, { exports, AbortSignal: signalClass, AbortController, DOMException, setTimeout, clearTimeout });
  return exports.timeoutSignal;
}

test('classroom browser without AbortSignal.timeout still fetches and aborts on timeout', async () => {
  const timeout = load({});
  const signal = timeout(20);
  assert.equal(signal.aborted, false);
  const response = await fetch('data:text/plain,hello', { signal });
  assert.equal(await response.text(), 'hello');
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.aborted, true);
  assert.equal(signal.reason.name, 'TimeoutError');
});

test('modern browsers retain their native timeout implementation', () => {
  const expected = new AbortController().signal;
  const timeout = load({ timeout(milliseconds) { assert.equal(milliseconds, 15000); return expected; } });
  assert.equal(timeout(15000), expected);
});
