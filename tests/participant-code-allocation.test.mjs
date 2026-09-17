import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import pg from "pg";
import { formatParticipantCode } from "../lib/participant-code.js";

test("participant allocation fills deleted P and T code gaps", { skip: !process.env.DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      CREATE TEMP TABLE participants (
        id uuid PRIMARY KEY,
        experiment_id text NOT NULL,
        external_code text NOT NULL,
        UNIQUE (experiment_id, external_code)
      ) ON COMMIT DROP
    `);
    await client.query(
      `INSERT INTO participants (id, experiment_id, external_code) VALUES
       ($1, 'gap-test', 'P001'), ($2, 'gap-test', 'P002'), ($3, 'gap-test', 'P004'),
       ($4, 'gap-test', 'T001'), ($5, 'gap-test', 'T003')`,
      [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    );

    const source = await readFile("lib/participant-code-allocation.ts", "utf8");
    const exports = {};
    const modules = {
      "server-only": {},
      "node:crypto": { randomUUID },
      "@/lib/participant-code": { formatParticipantCode },
    };
    vm.runInNewContext(
      ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, require: (name) => modules[name] },
    );

    assert.equal((await exports.createParticipantWithAvailableCode(client, "gap-test", "P")).participantCode, "P003");
    assert.equal((await exports.createParticipantWithAvailableCode(client, "gap-test", "T")).participantCode, "T002");
    await client.query("DELETE FROM participants WHERE experiment_id = 'gap-test' AND external_code = 'P002'");
    assert.equal((await exports.createParticipantWithAvailableCode(client, "gap-test", "P")).participantCode, "P002");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
