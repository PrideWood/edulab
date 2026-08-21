import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("secrets are documented as environment variables and ignored by git", async () => {
  const envExample = await readFile(".env.example", "utf8");
  const gitignore = await readFile(".gitignore", "utf8");
  assert.match(envExample, /COZE_API_TOKEN=/);
  assert.match(envExample, /DATABASE_URL=/);
  assert.match(gitignore, /\.env\*/);
});

test("database preserves message ordering and request idempotency", async () => {
  const migration = await readFile("db/migrations/0001_initial.sql", "utf8");
  assert.match(migration, /UNIQUE \(session_id, sequence_no\)/);
  assert.match(migration, /UNIQUE \(session_id, client_request_id\)/);
  assert.match(migration, /coze_conversation_id text/);
  assert.match(migration, /reply_completed_at timestamptz/);
});

test("admin settings keep credentials encrypted and preserve session conditions", async () => {
  const migration = await readFile("db/migrations/0002_admin_and_experiment_settings.sql", "utf8");
  const cryptoSource = await readFile("lib/secret-crypto.ts", "utf8");
  const sessionRoute = await readFile("app/api/sessions/route.ts", "utf8");
  assert.match(migration, /password_hash text NOT NULL/);
  assert.match(migration, /coze_token_ciphertext text/);
  assert.match(migration, /admin_audit_log/);
  assert.match(cryptoSource, /aes-256-gcm/);
  assert.match(sessionRoute, /config_snapshot/);
});

test("conversation export and optional database message storage are implemented", async () => {
  const migration = await readFile("db/migrations/0003_message_storage_control.sql", "utf8");
  const workspace = await readFile("app/workspace.tsx", "utf8");
  const cozeSource = await readFile("lib/coze.ts", "utf8");
  const completeRoute = await readFile("app/api/sessions/complete/route.ts", "utf8");
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  assert.match(migration, /database_message_storage_enabled boolean NOT NULL DEFAULT true/);
  assert.match(migration, /user_message_id DROP NOT NULL/);
  assert.match(workspace, /participantCode/);
  assert.match(workspace, /function exportTranscript/);
  assert.match(workspace, /下载实验记录/);
  assert.match(workspace, /replyStartedAt/);
  assert.match(workspace, /localStorage\.setItem\(transcriptKey/);
  assert.doesNotMatch(cozeSource, /INSERT INTO messages/);
  assert.match(completeRoute, /deferred_until_completion/);
  assert.match(completeRoute, /INSERT INTO messages/);
  assert.match(adminWorkspace, /实验结束时保存对话到数据库/);
});

test("multiple conversations are isolated to the authenticated participant session family", async () => {
  const route = await readFile("app/api/conversations/route.ts", "utf8");
  const workspace = await readFile("app/workspace.tsx", "utf8");
  const limits = await readFile("lib/experiment-limits.ts", "utf8");
  assert.match(route, /participant_id = \$2 AND experiment_id = \$3 AND session_secret_hash = \$4/);
  assert.match(route, /action: z\.literal\("create"\)/);
  assert.match(route, /action: z\.literal\("switch"\)/);
  assert.match(workspace, /conversation-sidebar/);
  assert.match(workspace, /收起侧边栏/);
  assert.match(limits, /s\.session_secret_hash = \$3/);
});
