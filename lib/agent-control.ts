import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/db";
import { buildSessionSnapshot, getExperimentSettings } from "@/lib/experiment-settings";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";
import { createRunEntryToken } from "@/lib/entry-token";
import { hashSecret } from "@/lib/security";

export type AssignmentMode = "fixed" | "balanced_random";

export interface AgentConfigSummary {
  id: string;
  internalName: string;
  baseUrl: string;
  botId: string;
  hasToken: boolean;
  tokenSource: "database" | "environment" | "missing";
  enabled: boolean;
  hasReferences: boolean;
  updatedAt: string;
}

export interface ExperimentRunSummary {
  id: string;
  name: string;
  status: "draft" | "active" | "closed";
  assignmentMode: AssignmentMode;
  fixedAgentId: string | null;
  randomAgentIds: string[];
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  entryToken: string | null;
  entryDeletedAt: string | null;
  isDefault: boolean;
}

interface AgentRow {
  id: string;
  experiment_id: string;
  internal_name: string;
  coze_api_base_url: string;
  coze_bot_id: string;
  coze_token_ciphertext: string | null;
  coze_token_iv: string | null;
  coze_token_tag: string | null;
  enabled: boolean;
  has_references?: boolean;
  updated_at: string;
}

interface RunRow {
  id: string;
  name: string;
  status: "draft" | "active" | "closed";
  assignment_mode: AssignmentMode;
  fixed_agent_id: string | null;
  random_agent_ids: string[];
  opened_at: string | null;
  closed_at: string | null;
  created_at: string;
  entry_token: string | null;
  entry_deleted_at: string | null;
  is_default: boolean;
}

function mapAgent(row: AgentRow): AgentConfigSummary {
  return {
    id: row.id,
    internalName: row.internal_name,
    baseUrl: row.coze_api_base_url,
    botId: row.coze_bot_id,
    hasToken: Boolean(row.coze_token_ciphertext || process.env.COZE_API_TOKEN),
    tokenSource: row.coze_token_ciphertext ? "database" : process.env.COZE_API_TOKEN ? "environment" : "missing",
    enabled: row.enabled,
    hasReferences: Boolean(row.has_references),
    updatedAt: row.updated_at,
  };
}

function mapRun(row: RunRow): ExperimentRunSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    assignmentMode: row.assignment_mode,
    fixedAgentId: row.fixed_agent_id,
    randomAgentIds: row.random_agent_ids,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    entryToken: row.entry_token,
    entryDeletedAt: row.entry_deleted_at ?? null,
    isDefault: row.is_default,
  };
}

export async function getAgentControl(experimentId: string) {
  const [agents, runs] = await Promise.all([
    query<AgentRow>(
      `SELECT agent.id, agent.experiment_id, agent.internal_name, agent.coze_api_base_url, agent.coze_bot_id,
         agent.coze_token_ciphertext, agent.coze_token_iv, agent.coze_token_tag, agent.enabled, agent.updated_at,
         (
           EXISTS (
             SELECT 1 FROM experiment_runs run
             WHERE run.experiment_id = agent.experiment_id
               AND (run.fixed_agent_id = agent.id OR agent.id = ANY(run.random_agent_ids))
               AND (run.status <> 'closed'
                 OR EXISTS (SELECT 1 FROM participant_agent_assignments a WHERE a.experiment_run_id = run.id)
                 OR EXISTS (SELECT 1 FROM experiment_sessions s WHERE s.experiment_run_id = run.id))
           )
           OR EXISTS (
             SELECT 1 FROM participant_agent_assignments assignment
             WHERE assignment.agent_id = agent.id
           )
           OR EXISTS (
             SELECT 1 FROM experiment_sessions session
             WHERE session.experiment_id = agent.experiment_id AND session.agent_id = agent.id
           )
         ) AS has_references
       FROM ai_agent_configs agent WHERE agent.experiment_id = $1 ORDER BY agent.created_at, agent.internal_name`,
      [experimentId],
    ),
    query<RunRow>(
      `SELECT id, name, status, assignment_mode, fixed_agent_id, random_agent_ids,
         opened_at, closed_at, created_at, entry_token, is_default, entry_deleted_at
       FROM experiment_runs WHERE experiment_id = $1
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, created_at DESC`,
      [experimentId],
    ),
  ]);
  return {
    agents: agents.rows.map(mapAgent),
    runs: runs.rows.map(mapRun),
    activeRun: runs.rows.find((row) => row.status === "active" && row.is_default) ? mapRun(runs.rows.find((row) => row.status === "active" && row.is_default)!) : null,
  };
}

export async function deleteAgentConfig(input: {
  experimentId: string;
  agentId: string;
  confirmationName: string;
}, adminUserId: string) {
  return transaction(async (client) => {
    const current = await client.query<AgentRow>(
      `SELECT id, experiment_id, internal_name, coze_api_base_url, coze_bot_id,
         coze_token_ciphertext, coze_token_iv, coze_token_tag, enabled, updated_at
       FROM ai_agent_configs WHERE id = $1 AND experiment_id = $2 FOR UPDATE`,
      [input.agentId, input.experimentId],
    );
    const agent = current.rows[0];
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    if (input.confirmationName !== agent.internal_name) throw new Error("AGENT_CONFIRMATION_MISMATCH");

    const references = await client.query<{ exists: boolean }>(
      `SELECT (
         EXISTS (
           SELECT 1 FROM experiment_runs run
           WHERE run.experiment_id = $1
             AND (run.fixed_agent_id = $2 OR $2 = ANY(run.random_agent_ids))
             AND (run.status <> 'closed'
               OR EXISTS (SELECT 1 FROM participant_agent_assignments a WHERE a.experiment_run_id = run.id)
               OR EXISTS (SELECT 1 FROM experiment_sessions s WHERE s.experiment_run_id = run.id))
         )
         OR EXISTS (
           SELECT 1 FROM participant_agent_assignments assignment
           JOIN experiment_runs run ON run.id = assignment.experiment_run_id
           WHERE run.experiment_id = $1 AND assignment.agent_id = $2
         )
         OR EXISTS (
           SELECT 1 FROM experiment_sessions session
           WHERE session.experiment_id = $1 AND session.agent_id = $2
         )
       ) AS exists`,
      [input.experimentId, input.agentId],
    );
    if (references.rows[0]?.exists) throw new Error("AGENT_HAS_REFERENCES");

    const emptyRuns = await client.query(
      `DELETE FROM experiment_runs run
       WHERE run.experiment_id = $1 AND run.status = 'closed'
         AND (run.fixed_agent_id = $2 OR $2 = ANY(run.random_agent_ids))
         AND NOT EXISTS (SELECT 1 FROM participant_agent_assignments a WHERE a.experiment_run_id = run.id)
         AND NOT EXISTS (SELECT 1 FROM experiment_sessions s WHERE s.experiment_run_id = run.id)
       RETURNING run.id, run.name, run.assignment_mode, run.fixed_agent_id, run.random_agent_ids`,
      [input.experimentId, input.agentId],
    );
    await client.query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, before_data)
       VALUES ($1,$2,'ai.agent.delete',$3,$4::jsonb)`,
      [randomUUID(), adminUserId, input.experimentId, JSON.stringify({ ...mapAgent(agent), removedEmptyRuns: emptyRuns.rows })],
    );
    await client.query(
      `DELETE FROM ai_agent_configs WHERE id = $1 AND experiment_id = $2`,
      [input.agentId, input.experimentId],
    );
    return mapAgent(agent);
  });
}

export async function saveAgentConfig(input: {
  id?: string;
  experimentId: string;
  internalName: string;
  baseUrl: string;
  botId: string;
  token?: string;
  enabled: boolean;
}, adminUserId: string) {
  return transaction(async (client) => {
    const id = input.id ?? randomUUID();
    const current = input.id ? await client.query<AgentRow>(
      `SELECT id, experiment_id, internal_name, coze_api_base_url, coze_bot_id,
         coze_token_ciphertext, coze_token_iv, coze_token_tag, enabled, updated_at
       FROM ai_agent_configs WHERE id = $1 AND experiment_id = $2 FOR UPDATE`,
      [input.id, input.experimentId],
    ) : null;
    if (input.id && !current?.rows[0]) throw new Error("AGENT_NOT_FOUND");
    if (input.id) {
      const activeUse = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM experiment_runs
           WHERE experiment_id = $1 AND status = 'active'
             AND (fixed_agent_id = $2 OR $2 = ANY(random_agent_ids))
         ) AS exists`,
        [input.experimentId, input.id],
      );
      if (activeUse.rows[0]?.exists) throw new Error("ACTIVE_AGENT_LOCKED");
    }
    const encrypted = input.token?.trim() ? encryptSecret(input.token.trim()) : null;
    const previous = current?.rows[0];
    const saved = await client.query<AgentRow>(
      `INSERT INTO ai_agent_configs (
         id, experiment_id, internal_name, coze_api_base_url, coze_bot_id,
         coze_token_ciphertext, coze_token_iv, coze_token_tag, enabled, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         internal_name = EXCLUDED.internal_name,
         coze_api_base_url = EXCLUDED.coze_api_base_url,
         coze_bot_id = EXCLUDED.coze_bot_id,
         coze_token_ciphertext = EXCLUDED.coze_token_ciphertext,
         coze_token_iv = EXCLUDED.coze_token_iv,
         coze_token_tag = EXCLUDED.coze_token_tag,
         enabled = EXCLUDED.enabled, updated_by = EXCLUDED.updated_by, updated_at = now()
       RETURNING id, experiment_id, internal_name, coze_api_base_url, coze_bot_id,
         coze_token_ciphertext, coze_token_iv, coze_token_tag, enabled, updated_at`,
      [id, input.experimentId, input.internalName, input.baseUrl, input.botId,
        encrypted?.ciphertext ?? previous?.coze_token_ciphertext ?? null,
        encrypted?.iv ?? previous?.coze_token_iv ?? null,
        encrypted?.tag ?? previous?.coze_token_tag ?? null,
        input.enabled, adminUserId],
    );
    await client.query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, before_data, after_data)
       VALUES ($1,$2,'ai.agent.save',$3,$4::jsonb,$5::jsonb)`,
      [randomUUID(), adminUserId, input.experimentId, JSON.stringify(previous ? mapAgent(previous) : null), JSON.stringify(mapAgent(saved.rows[0]))],
    );
    return mapAgent(saved.rows[0]);
  });
}

export async function resolveAgentTestConnection(input: {
  experimentId: string;
  id?: string;
  baseUrl: string;
  botId: string;
  token?: string;
}) {
  let token = input.token?.trim() ?? "";
  if (!token && input.id) {
    const current = await query<AgentRow>(
      `SELECT id, experiment_id, internal_name, coze_api_base_url, coze_bot_id,
         coze_token_ciphertext, coze_token_iv, coze_token_tag, enabled, updated_at
       FROM ai_agent_configs WHERE id = $1 AND experiment_id = $2`,
      [input.id, input.experimentId],
    );
    const agent = current.rows[0];
    if (!agent) throw new Error("AGENT_NOT_FOUND");
    if (agent.coze_token_ciphertext && agent.coze_token_iv && agent.coze_token_tag) {
      try {
        token = decryptSecret({
          ciphertext: agent.coze_token_ciphertext,
          iv: agent.coze_token_iv,
          tag: agent.coze_token_tag,
        });
      } catch {
        throw new Error("AGENT_TOKEN_DECRYPT_FAILED");
      }
    }
  }
  token ||= process.env.COZE_API_TOKEN ?? "";
  if (!token) throw new Error("COZE_TOKEN_NOT_CONFIGURED");
  return { token, baseUrl: input.baseUrl, botId: input.botId };
}

export async function activateExperimentRun(input: {
  experimentId: string;
  name: string;
  assignmentMode: AssignmentMode;
  fixedAgentId: string | null;
  randomAgentIds: string[];
  makeDefault?: boolean;
}, adminUserId: string) {
  return transaction(async (client) => {
    const selectedIds = input.assignmentMode === "fixed"
      ? (input.fixedAgentId ? [input.fixedAgentId] : [])
      : [...new Set(input.randomAgentIds)];
    if (selectedIds.length < (input.assignmentMode === "fixed" ? 1 : 2)) throw new Error("INVALID_RUN_AGENTS");
    const valid = await client.query<{ id: string }>(
      `SELECT id FROM ai_agent_configs
       WHERE experiment_id = $1 AND enabled = true AND id = ANY($2::uuid[]) FOR SHARE`,
      [input.experimentId, selectedIds],
    );
    if (valid.rows.length !== selectedIds.length) throw new Error("INVALID_RUN_AGENTS");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`edulab:run:${input.experimentId}`]);
    const makeDefault = input.makeDefault ?? true;
    if (makeDefault) await client.query(`UPDATE experiment_runs SET is_default=false WHERE experiment_id=$1 AND is_default=true`, [input.experimentId]);
    const snapshot = buildSessionSnapshot(await getExperimentSettings(input.experimentId,false));
    const entryToken = await createRunEntryToken(client);
    const created = await client.query<RunRow>(
      `INSERT INTO experiment_runs (
         id, experiment_id, name, status, assignment_mode, fixed_agent_id,
         random_agent_ids, opened_at, updated_by, entry_token, is_default, config_snapshot
       ) VALUES ($1,$2,$3,'active',$4,$5,$6::uuid[],now(),$7,$8,$9,$10::jsonb)
       RETURNING id, name, status, assignment_mode, fixed_agent_id, random_agent_ids,
         opened_at, closed_at, created_at, entry_token, is_default, entry_deleted_at`,
      [randomUUID(), input.experimentId, input.name, input.assignmentMode,
        input.assignmentMode === "fixed" ? input.fixedAgentId : null,
        input.assignmentMode === "balanced_random" ? selectedIds : [], adminUserId, entryToken, makeDefault, JSON.stringify(snapshot)],
    );
    await client.query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, after_data)
       VALUES ($1,$2,'experiment.run.activate',$3,$4::jsonb)`,
      [randomUUID(), adminUserId, input.experimentId, JSON.stringify(mapRun(created.rows[0]))],
    );
    return mapRun(created.rows[0]);
  });
}

export async function closeActiveExperimentRun(experimentId: string, adminUserId: string, runId?: string) {
  return transaction(async (client) => {
    const closed = await client.query<RunRow>(
      `UPDATE experiment_runs SET status = 'closed', closed_at = now(), updated_at = now(), updated_by = $2
       WHERE experiment_id = $1 AND status = 'active' AND (($3::uuid IS NULL AND is_default=true) OR id=$3)
       RETURNING id, name, status, assignment_mode, fixed_agent_id, random_agent_ids,
         opened_at, closed_at, created_at, entry_token, is_default, entry_deleted_at`,
      [experimentId, adminUserId, runId ?? null],
    );
    if (closed.rows[0]) {
      await client.query(
        `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, after_data)
         VALUES ($1,$2,'experiment.run.close',$3,$4::jsonb)`,
        [randomUUID(), adminUserId, experimentId, JSON.stringify(mapRun(closed.rows[0]))],
      );
    }
    return closed.rows[0] ? mapRun(closed.rows[0]) : null;
  });
}

export interface AssignedAgentRuntime {
  assignmentId: string;
  runId: string;
  runName: string;
  assignmentMode: AssignmentMode;
  agentId: string;
  internalName: string;
  baseUrl: string;
  botId: string;
  token: string;
}

const LIFECYCLE_RUN_SELECT = `SELECT id, name, status, assignment_mode, fixed_agent_id,
  random_agent_ids, opened_at, closed_at, created_at, entry_token, is_default, entry_deleted_at,
  metadata FROM experiment_runs WHERE id=$1 AND experiment_id=$2`;

export async function reopenExperimentRun(experimentId: string, runId: string, adminUserId: string) {
  return transaction(async (client) => {
    const initial = (await client.query<RunRow>(LIFECYCLE_RUN_SELECT, [runId, experimentId])).rows[0];
    if (!initial) throw new Error("RUN_NOT_FOUND");
    if (initial.entry_deleted_at) throw new Error("RUN_ENTRY_DELETED");
    const agentIds = initial.assignment_mode === "fixed"
      ? (initial.fixed_agent_id ? [initial.fixed_agent_id] : []) : initial.random_agent_ids;
    // Use the same agent-before-run lock order as activation and agent edits.
    const valid = await client.query(`SELECT id FROM ai_agent_configs
      WHERE experiment_id=$1 AND enabled=true AND id=ANY($2::uuid[]) FOR SHARE`, [experimentId, agentIds]);
    if (!agentIds.length || valid.rows.length !== agentIds.length) throw new Error("RUN_AGENT_UNAVAILABLE");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`edulab:run:${experimentId}`]);
    const current = (await client.query<RunRow>(`${LIFECYCLE_RUN_SELECT} FOR UPDATE`, [runId, experimentId])).rows[0];
    if (!current) throw new Error("RUN_NOT_FOUND");
    if (current.entry_deleted_at) throw new Error("RUN_ENTRY_DELETED");
    if (current.status === "active") return mapRun(current);
    await client.query(`UPDATE experiment_runs SET status='active', closed_at=NULL,
      opened_at=COALESCE(opened_at,now()), is_default=false, updated_at=now(), updated_by=$2 WHERE id=$1`, [runId, adminUserId]);
    const after = (await client.query<RunRow>(LIFECYCLE_RUN_SELECT, [runId, experimentId])).rows[0];
    await client.query(`INSERT INTO admin_audit_log (id,admin_user_id,action,experiment_id,before_data,after_data)
      VALUES ($1,$2,'experiment.run.reopen',$3,$4::jsonb,$5::jsonb)`,
    [randomUUID(),adminUserId,experimentId,JSON.stringify(mapRun(current)),JSON.stringify(mapRun(after))]);
    return mapRun(after);
  });
}

export async function deleteExperimentRunLink(input: {
  experimentId: string; runId: string; confirmationCode: string;
}, adminUserId: string) {
  return transaction(async (client) => {
    // Share the allocation lock so a released code is reused only after COMMIT.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`edulab:run:${input.experimentId}`]);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('edulab:entry-links',0))");
    const run = (await client.query<RunRow & { metadata: Record<string, unknown> }>(
      `${LIFECYCLE_RUN_SELECT} FOR UPDATE`, [input.runId, input.experimentId])).rows[0];
    if (!run) throw new Error("RUN_NOT_FOUND");
    if (run.entry_deleted_at) throw new Error("RUN_ENTRY_DELETED");
    if (run.status !== "closed") throw new Error("RUN_NOT_CLOSED");
    if (input.confirmationCode.trim().toLowerCase() !== run.entry_token) throw new Error("RUN_CONFIRMATION_MISMATCH");
    // Student writes and recovery hold these participant locks. Ending a run
    // cannot race a new send, conversation creation, draft save or recovery.
    await client.query(`SELECT p.id FROM participants p WHERE EXISTS (
      SELECT 1 FROM experiment_sessions s WHERE s.participant_id=p.id AND s.experiment_run_id=$1)
      ORDER BY p.id FOR UPDATE`, [input.runId]);
    const sessions = await client.query<{ id: string; active_request_id: string | null }>(
      "SELECT id,active_request_id FROM experiment_sessions WHERE experiment_run_id=$1 ORDER BY id FOR UPDATE", [input.runId]);
    const busy = await client.query<{ exists: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM chat_requests request JOIN experiment_sessions s ON s.id=request.session_id
      WHERE s.experiment_run_id=$1 AND request.status='in_progress') AS exists`, [input.runId]);
    if (sessions.rows.some((session) => session.active_request_id) || busy.rows[0].exists) throw new Error("RUN_BUSY");
    // The teacher confirms completion. Keep saved content, times, assignments
    // and provider IDs, while revoking all old write credentials for this run.
    await client.query(`UPDATE experiment_sessions SET status='completed',
      completed_at=COALESCE(completed_at,now()), session_secret_hash=$2,
      metadata=metadata || jsonb_build_object('entry_deleted_at',now()) || CASE WHEN status='active'
        THEN '{"end_reason":"entry_deleted_by_admin","completion_source":"admin_entry_delete"}'::jsonb ELSE '{}'::jsonb END
      WHERE experiment_run_id=$1`, [input.runId,hashSecret(randomUUID())]);
    await client.query(`UPDATE experiment_runs SET entry_token=NULL, entry_deleted_at=now(),
      is_default=false, updated_at=now(), updated_by=$2, metadata=metadata-'entry_token_aliases' WHERE id=$1`, [input.runId,adminUserId]);
    const after = (await client.query<RunRow>(LIFECYCLE_RUN_SELECT, [input.runId, input.experimentId])).rows[0];
    await client.query(`INSERT INTO admin_audit_log (id,admin_user_id,action,experiment_id,before_data,after_data)
      VALUES ($1,$2,'experiment.run.link.delete',$3,$4::jsonb,$5::jsonb)`,
    [randomUUID(),adminUserId,input.experimentId,
      JSON.stringify({ ...mapRun(run),entryTokenAliases:run.metadata.entry_token_aliases ?? [] }),
      JSON.stringify({ ...mapRun(after),preservedSessionCount:sessions.rows.length })]);
    return mapRun(after);
  });
}

export async function assignAgentWithClient(
  client: PoolClient,
  experimentId: string,
  participantId: string,
  runId?: string,
): Promise<AssignedAgentRuntime> {
  const run = await client.query<RunRow & { experiment_id: string }>(
    `SELECT id, experiment_id, name, status, assignment_mode, fixed_agent_id,
       random_agent_ids, opened_at, closed_at, created_at, entry_token, is_default
     FROM experiment_runs WHERE experiment_id = $1 AND status = 'active'
       AND (($2::uuid IS NULL AND is_default=true) OR id=$2) FOR SHARE`,
    [experimentId, runId ?? null],
  );
  const active = run.rows[0];
  if (!active) throw new Error("NO_ACTIVE_EXPERIMENT_RUN");
  const existing = await client.query<{ id: string; agent_id: string }>(
    `SELECT id, agent_id FROM participant_agent_assignments
     WHERE experiment_run_id = $1 AND participant_id = $2`,
    [active.id, participantId],
  );
  let assignmentId = existing.rows[0]?.id;
  let agentId: string | null | undefined = existing.rows[0]?.agent_id;
  if (!agentId) {
    if (active.assignment_mode === "fixed") {
      agentId = active.fixed_agent_id;
    } else {
      // Serialize only balanced assignment; fixed-agent entrants can share the run.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`edulab:assignment:${active.id}`]);
      const selected = await client.query<{ id: string }>(
        `SELECT candidate.id
         FROM unnest($2::uuid[]) AS candidate(id)
         JOIN ai_agent_configs a ON a.id = candidate.id AND a.experiment_id = $1 AND a.enabled = true
         LEFT JOIN participant_agent_assignments assignment
           ON assignment.experiment_run_id = $3 AND assignment.agent_id = candidate.id
         GROUP BY candidate.id
         ORDER BY count(assignment.id), random()
         LIMIT 1`,
        [experimentId, active.random_agent_ids, active.id],
      );
      agentId = selected.rows[0]?.id;
    }
    if (!agentId) throw new Error("NO_AVAILABLE_AGENT");
    assignmentId = randomUUID();
    await client.query(
      `INSERT INTO participant_agent_assignments (
         id, experiment_run_id, participant_id, agent_id, assignment_mode
       ) VALUES ($1,$2,$3,$4,$5)`,
      [assignmentId, active.id, participantId, agentId, active.assignment_mode],
    );
  }
  const agent = await client.query<AgentRow>(
    `SELECT id, experiment_id, internal_name, coze_api_base_url, coze_bot_id,
       coze_token_ciphertext, coze_token_iv, coze_token_tag, enabled, updated_at
     FROM ai_agent_configs WHERE id = $1 AND experiment_id = $2 AND enabled = true`,
    [agentId, experimentId],
  );
  const selected = agent.rows[0];
  if (!selected) throw new Error("NO_AVAILABLE_AGENT");
  let token = process.env.COZE_API_TOKEN ?? "";
  if (selected.coze_token_ciphertext && selected.coze_token_iv && selected.coze_token_tag) {
    token = decryptSecret({
      ciphertext: selected.coze_token_ciphertext,
      iv: selected.coze_token_iv,
      tag: selected.coze_token_tag,
    });
  }
  if (!token) throw new Error("COZE_TOKEN_NOT_CONFIGURED");
  return {
    assignmentId: assignmentId!, runId: active.id, runName: active.name,
    assignmentMode: active.assignment_mode, agentId: selected.id,
    internalName: selected.internal_name, baseUrl: selected.coze_api_base_url,
    botId: selected.coze_bot_id, token,
  };
}
