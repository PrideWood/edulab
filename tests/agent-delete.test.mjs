import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";
import pg from "pg";

test("agent deletion protects live records but clears empty closed runs", { skip: !process.env.DATABASE_URL }, async () => {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  await client.connect();
  try {
    await client.query("BEGIN");
    // All unqualified names resolve to temporary tables, never production data.
    await client.query(`
      CREATE TEMP TABLE ai_agent_configs (
        id uuid PRIMARY KEY, experiment_id text, internal_name text, coze_api_base_url text,
        coze_bot_id text, coze_token_ciphertext text, coze_token_iv text, coze_token_tag text,
        enabled boolean, updated_at timestamptz DEFAULT now(), created_at timestamptz DEFAULT now()
      ) ON COMMIT DROP;
      CREATE TEMP TABLE experiment_runs (
        id uuid PRIMARY KEY, experiment_id text, name text, status text, assignment_mode text,
        fixed_agent_id uuid REFERENCES ai_agent_configs(id), random_agent_ids uuid[] DEFAULT '{}',
        opened_at timestamptz, closed_at timestamptz, created_at timestamptz DEFAULT now()
      ) ON COMMIT DROP;
      CREATE TEMP TABLE participant_agent_assignments (
        id uuid, experiment_run_id uuid REFERENCES experiment_runs(id), agent_id uuid REFERENCES ai_agent_configs(id)
      ) ON COMMIT DROP;
      CREATE TEMP TABLE experiment_sessions (
        id uuid, experiment_id text, experiment_run_id uuid REFERENCES experiment_runs(id), agent_id uuid REFERENCES ai_agent_configs(id)
      ) ON COMMIT DROP;
      CREATE TEMP TABLE admin_audit_log (id uuid, admin_user_id uuid, action text, experiment_id text, before_data jsonb) ON COMMIT DROP;
    `);
    const source = await readFile("lib/agent-control.ts", "utf8");
    const exports = {};
    const modules = {
      "server-only": {}, "node:crypto": { randomUUID },
      "@/db": { query: (...args) => client.query(...args), transaction: (work) => work(client) },
      "@/lib/secret-crypto": {},
    };
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
      { exports, process: { env: {} }, Error, require: (name) => modules[name] });
    const agentId = randomUUID(), otherId = randomUUID(), runId = randomUUID();
    await client.query("INSERT INTO ai_agent_configs (id,experiment_id,internal_name,enabled) VALUES ($1,'test','agent',true),($2,'test','other',true)", [agentId, otherId]);
    await client.query("INSERT INTO experiment_runs (id,experiment_id,name,status,assignment_mode,random_agent_ids) VALUES ($1,'test','run','active','balanced_random',$2)", [runId, [agentId, otherId]]);
    const remove = () => exports.deleteAgentConfig({ experimentId: "test", agentId, confirmationName: "agent" }, randomUUID());
    assert.equal((await exports.getAgentControl("test")).agents[0].hasReferences, true);
    await assert.rejects(remove, /AGENT_HAS_REFERENCES/);
    await client.query("UPDATE experiment_runs SET status='closed'");
    await client.query("INSERT INTO experiment_sessions VALUES ($1,'test',$2,$3)", [randomUUID(), runId, otherId]);
    await assert.rejects(remove, /AGENT_HAS_REFERENCES/);
    await client.query("DELETE FROM experiment_sessions");
    await client.query("INSERT INTO participant_agent_assignments VALUES ($1,$2,$3)", [randomUUID(), runId, agentId]);
    await assert.rejects(remove, /AGENT_HAS_REFERENCES/);
    await client.query("DELETE FROM participant_agent_assignments");
    assert.equal((await exports.getAgentControl("test")).agents[0].hasReferences, false);
    await assert.rejects(() => exports.deleteAgentConfig({ experimentId: "test", agentId, confirmationName: "wrong" }, randomUUID()), /AGENT_CONFIRMATION_MISMATCH/);
    await remove();
    assert.equal((await client.query("SELECT * FROM experiment_runs")).rowCount, 0);
    assert.equal((await client.query("SELECT * FROM ai_agent_configs")).rowCount, 1);
    assert.equal((await client.query("SELECT before_data FROM admin_audit_log")).rows[0].before_data.removedEmptyRuns[0].id, runId);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
