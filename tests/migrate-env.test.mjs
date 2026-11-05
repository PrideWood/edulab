import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const envModule = pathToFileURL(require.resolve('@next/env')).href;
const source = (await readFile('scripts/migrate.mjs', 'utf8'))
  .replace('import pg from "pg";', `const pg = { Client: class {
    constructor(config) {
      if (config.connectionString !== process.env.EXPECTED_DATABASE_URL) throw new Error('Wrong database selection');
      if (config.ssl !== false) throw new Error('DATABASE_SSL was not loaded');
    }
    async connect() {} async query() { return { rowCount: 1 }; } async end() {}
  }};`)
  .replace('from "@next/env"', `from ${JSON.stringify(envModule)}`);

for (const external of [false, true]) {
  test(`migration loads .env.local and .env with ${external ? 'terminal override' : 'local file priority'}`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'edulab-migrate-env-'));
    try {
      await mkdir(path.join(directory, 'db/migrations'), { recursive: true });
      await writeFile(path.join(directory, '.env'), 'DATABASE_URL=postgresql://synthetic/base\nDATABASE_SSL=disable\n');
      await writeFile(path.join(directory, '.env.local'), 'DATABASE_URL=postgresql://synthetic/local\n');
      const env = { ...process.env, NODE_ENV: 'development', EXPECTED_DATABASE_URL: `postgresql://synthetic/${external ? 'terminal' : 'local'}` };
      for (const key of ['DATABASE_URL', 'DATABASE_SSL', '__NEXT_PROCESSED_ENV']) delete env[key];
      if (external) env.DATABASE_URL = env.EXPECTED_DATABASE_URL;
      const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], { cwd: directory, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
