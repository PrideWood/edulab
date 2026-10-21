import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { getSupportedBrowsers } from 'next/dist/build/get-supported-browsers.js';

const source = ts.transpileModule(await readFile('lib/client-request-id.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2017 },
}).outputText;
function load(crypto) {
  const exports = {};
  vm.runInNewContext(source, { exports, crypto, Uint8Array });
  return exports.newClientRequestId;
}

test('production compiler includes the school Chrome 95 baseline', () => {
  assert.ok(getSupportedBrowsers(process.cwd(), false).includes('chrome 95'));
});

test('request ID generation preserves the native crypto receiver', () => {
  const crypto = { randomUUID() { assert.equal(this, crypto); return 'native-request-id'; } };
  assert.equal(load(crypto)(), 'native-request-id');
});

test('without randomUUID, secure random bytes produce unique UUID v4 IDs accepted by the API', () => {
  const create = load({ getRandomValues: bytes => webcrypto.getRandomValues(bytes) });
  const ids = new Set(Array.from({ length: 1000 }, create));
  assert.equal(ids.size, 1000);
  for (const id of ids) assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
});

test('UUID fallback sets the version and variant without discarding other entropy', () => {
  const create = load({ getRandomValues: bytes => bytes.fill(255) });
  assert.equal(create(), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
});
