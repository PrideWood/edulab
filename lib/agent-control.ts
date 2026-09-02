import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { query, transaction } from "@/db";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

export type AssignmentMode = "fixed" | "balanced_random";

export interface AgentConfigSummary {
  id: string;
  internalName: string;
  baseUrl: string;
  botId: string;
  hasToken: boolean;
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
}

function mapAgent(row: AgentRow): AgentConfigSummary {
  return {
    id: row.id,
    internalName: row.internal_name,
    baseUrl: row.coze_api_base_url,
    botId: row.coze_bot_id,
    hasToken: Boolean(row.coze_token_ciphertext || process.env.COZE_API_TOKEN),
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
         opened_at, closed_at, created_at
       FROM experiment_runs WHERE experiment_id = $1
       ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, created_at DESC`,
      [experimentId],
    ),
  ]);
  return {
    agents: agents.rows.map(mapAgent),
    runs: runs.rows.map(mapRun),
    activeRun: runs.rows.find((row) => row.status === "active") ? mapRun(runs.rows.find((row) => row.status === "active")!) : null,
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

    await client.query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, before_data)
       VALUES ($1,$2,'ai.agent.delete',$3,$4::jsonb)`,
      [randomUUID(), adminUserId, input.experimentId, JSON.stringify(mapAgent(agent))],
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

export async function activateExperimentRun(input: {
  experimentId: string;
  name: string;
  assignmentMode: AssignmentMode;
  fixedAgentId: string | null;
  randomAgentIds: string[];
}, adminUserId: string) {
  return transaction(async (client) => {
    const selectedIds = input.assignmentMode === "fixed"
      ? (input.fixedAgentId ? [input.fixedAgentId] : [])
      : [...new Set(input.randomAgentIds)];
    if (selectedIds.length < (input.assignmentMode === "fixed" ? 1 : 2)) throw new Error("INVALID_RUN_AGENTS");
    const valid = await client.query<{ id: string }>(
      `SELECT id FROM ai_agent_configs
       WHERE experiment_id = $1 AND enabled = true AND id = ANY($2::uuid[])`,
      [input.experimentId, selectedIds],
    );
    if (valid.rows.length !== selectedIds.length) throw new Error("INVALID_RUN_AGENTS");
    await client.query(
      `UPDATE experiment_runs SET status = 'closed', closed_at = now(), updated_at = now(), updated_by = $2
       WHERE experiment_id = $1 AND status = 'active'`,
      [input.experimentId, adminUserId],
    );
    const created = await client.query<RunRow>(
      `INSERT INTO experiment_runs (
         id, experiment_id, name, status, assignment_mode, fixed_agent_id,
         random_agent_ids, opened_at, updated_by
       ) VALUES ($1,$2,$3,'active',$4,$5,$6::uuid[],now(),$7)
       RETURNING id, name, status, assignment_mode, fixed_agent_id, random_agent_ids,
         opened_at, closed_at, created_at`,
      [randomUUID(), input.experimentId, input.name, input.assignmentMode,
        input.assignmentMode === "fixed" ? input.fixedAgentId : null,
        input.assignmentMode === "balanced_random" ? selectedIds : [], adminUserId],
    );
    await client.query(
      `INSERT INTO admin_audit_log (id, admin_user_id, action, experiment_id, after_data)
       VALUES ($1,$2,'experiment.run.activate',$3,$4::jsonb)`,
      [randomUUID(), adminUserId, input.experimentId, JSON.stringify(mapRun(created.rows[0]))],
    );
    return mapRun(created.rows[0]);
  });
}

export async function closeActiveExperimentRun(experimentId: string, adminUserId: string) {
  return transaction(async (client) => {
    const closed = await client.query<RunRow>(
      `UPDATE experiment_runs SET status = 'closed', closed_at = now(), updated_at = now(), updated_by = $2
       WHERE experiment_id = $1 AND status = 'active'
       RETURNING id, name, status, assignment_mode, fixed_agent_id, random_agent_ids,
         opened_at, closed_at, created_at`,
      [experimentId, adminUserId],
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

export async function assignAgentWithClient(
  client: PoolClient,
  experimentId: string,
  participantId: string,
): Promise<AssignedAgentRuntime> {
  const run = await client.query<RunRow & { experiment_id: string }>(
    `SELECT id, experiment_id, name, status, assignment_mode, fixed_agent_id,
       random_agent_ids, opened_at, closed_at, created_at
     FROM experiment_runs WHERE experiment_id = $1 AND status = 'active' FOR UPDATE`,
    [experimentId],
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
