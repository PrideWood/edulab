import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("secrets are documented as environment variables and ignored by git", async () => {
  const envExample = await readFile(".env.example", "utf8");
  const gitignore = await readFile(".gitignore", "utf8");
  assert.match(envExample, /COZE_API_TOKEN=/);
  assert.match(envExample, /DATABASE_URL=/);
  assert.match(envExample, /ACCESS_CODE=/);
  assert.match(gitignore, /\.env\*/);
});

test("access code protects student pages and APIs without exposing the secret", async () => {
  const accessSource = await readFile("lib/access-code.ts", "utf8");
  const proxySource = await readFile("proxy.ts", "utf8");
  const verifyRoute = await readFile("app/api/access/verify/route.ts", "utf8");
  const formSource = await readFile("app/access/access-code-form.tsx", "utf8");
  assert.match(proxySource, /process\.env\.ACCESS_CODE/);
  assert.match(proxySource, /\/api\/messages\/:path\*/);
  assert.match(proxySource, /verifyAccessCookie/);
  assert.match(accessSource, /crypto\.subtle\.sign\("HMAC"/);
  assert.match(verifyRoute, /httpOnly: true/);
  assert.match(verifyRoute, /sameSite: "lax"/);
  assert.match(verifyRoute, /secure: process\.env\.NODE_ENV === "production"/);
  assert.doesNotMatch(formSource, /process\.env\.ACCESS_CODE/);
  assert.doesNotMatch(formSource, /NEXT_PUBLIC/);
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
  const turnMigration = await readFile("db/migrations/0005_turn_index.sql", "utf8");
  const workspace = await readFile("app/workspace.tsx", "utf8");
  const cozeSource = await readFile("lib/coze.ts", "utf8");
  const completeRoute = await readFile("app/api/sessions/complete/route.ts", "utf8");
  const checkpointRoute = await readFile("app/api/sessions/checkpoint/route.ts", "utf8");
  const transcriptSource = await readFile("lib/transcript.ts", "utf8");
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  assert.match(migration, /database_message_storage_enabled boolean NOT NULL DEFAULT true/);
  assert.match(migration, /user_message_id DROP NOT NULL/);
  assert.match(workspace, /participantCode/);
  assert.match(workspace, /function exportTranscript/);
  assert.match(workspace, /下载交互记录/);
  assert.match(workspace, /replyStartedAt/);
  assert.match(workspace, /localStorage\.setItem\(transcriptKey/);
  assert.match(workspace, /turnIndex: message\.turnIndex/);
  assert.ok(
    workspace.indexOf("writeLocalTranscript(activeSessionRef.current") < workspace.indexOf('fetch("/api/messages"'),
    "the participant message must be persisted locally before the Coze request starts",
  );
  assert.doesNotMatch(cozeSource, /INSERT INTO messages/);
  assert.match(cozeSource, /role: "user"/);
  assert.match(completeRoute, /automatic_completion/);
  assert.match(checkpointRoute, /background_checkpoint/);
  assert.match(transcriptSource, /INSERT INTO messages/);
  assert.match(transcriptSource, /INCOMPLETE_TRANSCRIPT/);
  assert.match(workspace, /beforeunload/);
  assert.match(workspace, /sendBeacon/);
  assert.match(workspace, /\/api\/sessions\/checkpoint/);
  assert.match(workspace, /\/api\/sessions\/reset/);
  assert.match(workspace, /开始下一位参与者/);
  assert.match(workspace, /exportParticipantArchive/);
  assert.match(turnMigration, /ADD COLUMN IF NOT EXISTS turn_index integer/);
  assert.match(turnMigration, /UNIQUE \(session_id, turn_index\)/);
  assert.match(adminWorkspace, /实验结束时备份完整对话到数据库/);
});

test("the student message fast path calls Coze without waiting for PostgreSQL", async () => {
  const messageRoute = await readFile("app/api/messages/route.ts", "utf8");
  const runtimeSource = await readFile("lib/runtime-session.ts", "utf8");
  const workspace = await readFile("app/workspace.tsx", "utf8");
  const fastPathStart = messageRoute.indexOf("async function postWithoutDatabase");
  const fastPathEnd = messageRoute.indexOf("async function responsePayload");
  assert.ok(fastPathStart >= 0 && fastPathEnd > fastPathStart);
  assert.doesNotMatch(messageRoute.slice(fastPathStart, fastPathEnd), /query\(|transaction\(|beginChatRequest|getAuthenticatedSession/);
  assert.match(messageRoute, /getRuntimeSession\(\)/);
  assert.match(messageRoute, /runCozeChatWithoutDatabase/);
  assert.match(runtimeSource, /httpOnly: true/);
  assert.doesNotMatch(workspace.slice(workspace.indexOf("const sendWithId"), workspace.indexOf("useEffect(() =>", workspace.indexOf("const sendWithId"))), /checkpointTranscript/);
});

test("multiple agents and controlled experiment runs are persisted", async () => {
  const migration = await readFile("db/migrations/0008_multi_agent_experiment_runs.sql", "utf8");
  const agentControl = await readFile("lib/agent-control.ts", "utf8");
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  assert.match(migration, /CREATE TABLE IF NOT EXISTS ai_agent_configs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS experiment_runs/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS participant_agent_assignments/);
  assert.match(migration, /experiment_runs_one_active_idx/);
  assert.match(agentControl, /assignment_mode === "fixed"/);
  assert.match(agentControl, /ORDER BY count\(assignment\.id\), random\(\)/);
  assert.match(adminWorkspace, /固定智能体/);
  assert.match(adminWorkspace, /均衡随机分配/);
});

test("admin destructive actions require typed confirmation and preserve referenced agents", async () => {
  const adminRecords = await readFile("lib/admin-records.ts", "utf8");
  const participantsRoute = await readFile("app/api/admin/participants/route.ts", "utf8");
  const agentControl = await readFile("lib/agent-control.ts", "utf8");
  const agentRoute = await readFile("app/api/admin/agent-control/route.ts", "utf8");
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  assert.match(participantsRoute, /export async function DELETE/);
  assert.match(participantsRoute, /assertSameOrigin/);
  assert.match(adminRecords, /PARTICIPANT_CONFIRMATION_MISMATCH/);
  assert.match(adminRecords, /DELETE FROM messages/);
  assert.match(adminRecords, /DELETE FROM chat_requests/);
  assert.match(adminRecords, /participant\.record\.delete/);
  assert.match(agentRoute, /export async function DELETE/);
  assert.match(agentControl, /AGENT_CONFIRMATION_MISMATCH/);
  assert.match(agentControl, /AGENT_HAS_REFERENCES/);
  assert.match(agentControl, /ai\.agent\.delete/);
  assert.match(adminWorkspace, /function DangerConfirmation/);
  assert.match(adminWorkspace, /confirmation !== expectedValue/);
});

test("deleting a participant invalidates stale browser state without adding database work to message delivery", async () => {
  const participantsRoute = await readFile("app/api/admin/participants/route.ts", "utf8");
  const resetRoute = await readFile("app/api/sessions/reset/route.ts", "utf8");
  const workspace = await readFile("app/workspace.tsx", "utf8");
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  const messageRoute = await readFile("app/api/messages/route.ts", "utf8");
  assert.match(participantsRoute, /clearRuntimeCookie/);
  assert.match(participantsRoute, /runtime\?\.session\.participantId === deleted\.participantId/);
  assert.match(resetRoute, /orphaned: true/);
  assert.match(resetRoute, /hasSessionCookie/);
  assert.match(workspace, /clearLocalParticipantData/);
  assert.match(workspace, /visibilitychange/);
  assert.match(workspace, /releaseInvalidatedSession/);
  assert.match(workspace, /participant_deleted/);
  assert.match(adminWorkspace, /participant_deleted/);
  const fastPathStart = messageRoute.indexOf("async function postWithoutDatabase");
  const fastPathEnd = messageRoute.indexOf("async function responsePayload");
  assert.doesNotMatch(messageRoute.slice(fastPathStart, fastPathEnd), /query\(|transaction\(|getAuthenticatedSession/);
});

test("Coze failures preserve the provider error instead of parsing a missing message list", async () => {
  const cozeSource = await readFile("lib/coze.ts", "utf8");
  const messageRoute = await readFile("app/api/messages/route.ts", "utf8");
  const messagesSource = await readFile("lib/messages.ts", "utf8");
  assert.match(cozeSource, /current\.status !== ChatStatus\.COMPLETED/);
  assert.match(cozeSource, /throw failure/);
  assert.match(messageRoute, /error instanceof CozeChatError/);
  assert.match(messageRoute, /formatCozeError\(error\)/);
  assert.match(messagesSource, /Coze 返回错误/);
});

test("student device switching finalizes the participant and clears only the participant session", async () => {
  const resetRoute = await readFile("app/api/sessions/reset/route.ts", "utf8");
  assert.match(resetRoute, /storageMode: "participant_switch"/);
  assert.match(resetRoute, /end_reason: "participant_switch"/);
  assert.match(resetRoute, /SESSION_COOKIE/);
  assert.match(resetRoute, /maxAge: 0/);
  assert.doesNotMatch(resetRoute, /ACCESS_COOKIE/);
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

test("participant identity is separately encrypted and required before chat", async () => {
  const migration = await readFile("db/migrations/0006_participant_identity_profiles.sql", "utf8");
  const profileSource = await readFile("lib/participant-profile.ts", "utf8");
  const profileRoute = await readFile("app/api/participant-profile/route.ts", "utf8");
  const adminRoute = await readFile("app/api/admin/participants/route.ts", "utf8");
  const limits = await readFile("lib/experiment-limits.ts", "utf8");
  const workspace = await readFile("app/workspace.tsx", "utf8");
  assert.match(migration, /participant_id uuid PRIMARY KEY REFERENCES participants\(id\)/);
  assert.doesNotMatch(migration, /full_name text/);
  assert.match(migration, /full_name_ciphertext text/);
  assert.match(migration, /student_number_ciphertext text/);
  assert.match(profileSource, /encryptSecret/);
  assert.match(profileRoute, /getAuthenticatedSession/);
  assert.match(adminRoute, /getAuthenticatedAdmin/);
  assert.match(limits, /PARTICIPANT_PROFILE_REQUIRED/);
  assert.match(workspace, /参与者信息/);
  assert.doesNotMatch(workspace, /participant: \{ code: session\.participantCode, fullName/);
});

test("shared experiment entry creates a sequential participant only after identity submission", async () => {
  const migration = await readFile("db/migrations/0007_sequential_participant_codes.sql", "utf8");
  const sessionRoute = await readFile("app/api/sessions/route.ts", "utf8");
  const workspace = await readFile("app/workspace.tsx", "utf8");
  assert.match(sessionRoute, /participantCode: z\.string\(\).*\.optional\(\)/);
  assert.match(migration, /participant_code_counters/);
  assert.match(sessionRoute, /formatParticipantCode/);
  assert.match(sessionRoute, /padStart\(3, "0"\)/);
  assert.match(sessionRoute, /saveParticipantProfileWithClient/);
  assert.match(sessionRoute, /requestedParticipantCode && !verifyParticipantAccess/);
  assert.match(workspace, /response\.status === 401/);
  assert.match(workspace, /setProfileOpen\(true\)/);
  assert.match(workspace, /profile: \{ fullName: profileFullName, studentNumber: profileStudentNumber \}/);
  assert.doesNotMatch(workspace, /body: JSON\.stringify\(\{\}\)/);
  assert.doesNotMatch(workspace, /请使用研究者提供的完整实验链接进入/);
});

test("welcome copy is presentation-only and never becomes a recorded message", async () => {
  const workspace = await readFile("app/workspace.tsx", "utf8");
  assert.match(workspace, /className="conversation-welcome"/);
  assert.doesNotMatch(workspace, /message-row assistant"><div className="bubble"><p className="welcome-title"/);
});

test("assistant display name is editable even when optional task content is hidden", async () => {
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  const contentStart = adminWorkspace.indexOf("function ContentSettings");
  const limitsStart = adminWorkspace.indexOf("function LimitSettings");
  const storageStart = adminWorkspace.indexOf("function StorageSettings");
  assert.ok(contentStart >= 0 && limitsStart > contentStart && storageStart > limitsStart);
  assert.doesNotMatch(adminWorkspace.slice(contentStart, limitsStart), /assistantName|开场欢迎语/);
  assert.match(adminWorkspace.slice(limitsStart, storageStart), /学生端 AI 显示/);
  assert.match(adminWorkspace.slice(limitsStart, storageStart), /assistantName/);
  assert.match(adminWorkspace.slice(limitsStart, storageStart), /welcome/);
});

test("admin can batch export selected interactions separately from identity data", async () => {
  const route = await readFile("app/api/admin/exports/route.ts", "utf8");
  const exportSource = await readFile("lib/admin-export.ts", "utf8");
  const sharedFormat = await readFile("lib/transcript-export.ts", "utf8");
  const studentWorkspace = await readFile("app/workspace.tsx", "utf8");
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  assert.match(route, /assertSameOrigin\(request\)/);
  assert.match(route, /getAuthenticatedAdmin/);
  assert.match(route, /interactions_zip/);
  assert.match(route, /identity_csv/);
  assert.match(route, /application\/zip/);
  assert.match(route, /private, no-store/);
  assert.match(exportSource, /manifest\.json/);
  assert.match(exportSource, /possibly_incomplete/);
  assert.match(exportSource, /participant\.identity\.export/);
  assert.match(exportSource, /experiment\.records\.export/);
  assert.match(exportSource, /role, content, sent_at/);
  assert.match(exportSource, /turn_index/);
  assert.match(sharedFormat, /participantMessageCount/);
  assert.match(sharedFormat, /assistantMessageCount/);
  assert.match(studentWorkspace, /buildTranscriptExport/);
  assert.match(exportSource, /buildTranscriptExport/);
  assert.match(adminWorkspace, /全选当前列表中的参与者/);
  assert.match(adminWorkspace, /导出交互记录 \(\.zip\)/);
  assert.match(adminWorkspace, /身份对应表包含姓名或学号等敏感信息/);
});

test("admin agent configuration uses a compact editable table", async () => {
  const adminWorkspace = await readFile("app/admin/workspace.tsx", "utf8");
  const adminStyles = await readFile("app/admin/admin.css", "utf8");
  assert.match(adminWorkspace, /className="agent-table"/);
  assert.match(adminWorkspace, /section === "ai" \? "wide"/);
  assert.match(adminWorkspace, /<th>API 地址<\/th>/);
  assert.match(adminWorkspace, /<th>Bot ID<\/th>/);
  assert.match(adminWorkspace, /<th>API Token<\/th>/);
  assert.match(adminWorkspace, /function AgentTableRow/);
  assert.match(adminWorkspace, /agent-row-save/);
  assert.match(adminWorkspace, /agent-row-delete/);
  assert.doesNotMatch(adminWorkspace, /agent-config-card/);
  assert.match(adminStyles, /\.agent-table-wrap \{[^}]*max-height: 460px;[^}]*overflow: auto;/);
  assert.match(adminStyles, /\.agent-table th \{[^}]*position: sticky;/);
});
