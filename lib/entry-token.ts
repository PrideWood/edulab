import "server-only";
import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { ENTRY_CODE_ALPHABET } from "@/lib/entry-links";

// Existing metadata and the transactional audit trail hold retired codes.
// Older deletions did not prove a code was unused: reserve them conservatively.
export const RESERVED_ENTRY_TOKENS_SQL = `
  SELECT metadata->>'retired_entry_token' AS entry_token, id::text AS run_id
  FROM experiment_runs
  WHERE entry_deleted_at IS NOT NULL AND metadata->>'entry_code_reserved' = 'true'
  UNION
  SELECT before_data->>'entryToken' AS entry_token, before_data->>'id' AS run_id
  FROM admin_audit_log
  WHERE action = 'experiment.run.link.delete' AND before_data->>'entryToken' IS NOT NULL
    AND COALESCE(after_data->>'entryCodeReserved', 'true') = 'true'
  UNION
  SELECT retired->>'entryToken', retired->>'id'
  FROM admin_audit_log audit CROSS JOIN LATERAL jsonb_array_elements(audit.before_data->'removedEmptyRuns') retired
  WHERE audit.action='ai.agent.delete' AND retired->>'entryToken' IS NOT NULL
    AND COALESCE(retired->>'entryCodeReserved','true')='true'`;

// Recheck released empty entries at allocation time: the original agent may
// have acquired a different live entry or experiment records since deletion.
const RELEASED_ENTRY_TOKENS_IN_USE_SQL = `
  WITH released_entries AS (
    SELECT before_data AS config,experiment_id FROM admin_audit_log
      WHERE action='experiment.run.link.delete' AND after_data->>'entryCodeReserved'='false'
    UNION ALL
    SELECT retired,experiment_id FROM admin_audit_log audit
      CROSS JOIN LATERAL jsonb_array_elements(audit.before_data->'removedEmptyRuns') retired
      WHERE audit.action='ai.agent.delete' AND retired->>'entryCodeReserved'='false'
  ), released AS (
    SELECT config->>'entryToken' AS entry_token,
      ARRAY(SELECT agent.id FROM ai_agent_configs agent WHERE agent.experiment_id=released_entries.experiment_id
        AND (agent.id::text=config->>'fixedAgentId' OR config->'randomAgentIds' ? agent.id::text)) AS agent_ids
    FROM released_entries
  )
  SELECT entry_token FROM released WHERE
    EXISTS (SELECT 1 FROM participant_agent_assignments a WHERE a.agent_id=ANY(released.agent_ids))
    OR EXISTS (SELECT 1 FROM experiment_sessions s WHERE s.agent_id=ANY(released.agent_ids)
      OR s.config_snapshot->'ai'->>'agentId'=ANY(released.agent_ids::text[]))
    OR EXISTS (SELECT 1 FROM experiment_runs run
      WHERE (run.fixed_agent_id=ANY(released.agent_ids) OR run.random_agent_ids && released.agent_ids)
        AND (run.entry_deleted_at IS NULL
          OR EXISTS (SELECT 1 FROM participant_agent_assignments a WHERE a.experiment_run_id=run.id)
          OR EXISTS (SELECT 1 FROM experiment_sessions s WHERE s.experiment_run_id=run.id)))`;

export async function createRunEntryToken(client: PoolClient) {
  // Entry creation is rare. Serialize this short allocation only, ensuring
  // concurrent teachers cannot receive identical or nearly identical codes.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('edulab:entry-links',0))");
  const existing = await client.query<{ entry_token: string; blocked: boolean }>(
    `SELECT entry_token, true AS blocked FROM experiment_runs WHERE length(entry_token)=4
     UNION SELECT entry_token, true AS blocked FROM (${RESERVED_ENTRY_TOKENS_SQL}) reserved WHERE length(entry_token)=4
     UNION SELECT entry_token, true AS blocked FROM (${RELEASED_ENTRY_TOKENS_IN_USE_SQL}) in_use WHERE length(entry_token)=4
     UNION SELECT before_data->>'entryToken', false AS blocked FROM admin_audit_log
       WHERE action='experiment.run.link.delete' AND after_data->>'entryCodeReserved'='false'
         AND length(before_data->>'entryToken')=4
     UNION SELECT retired->>'entryToken', false AS blocked FROM admin_audit_log audit
       CROSS JOIN LATERAL jsonb_array_elements(audit.before_data->'removedEmptyRuns') retired
       WHERE audit.action='ai.agent.delete' AND retired->>'entryCodeReserved'='false'
         AND length(retired->>'entryToken')=4`);
  const blocked = existing.rows.filter(row => row.blocked);
  const released = new Set(existing.rows.filter(row => !row.blocked).map(row => row.entry_token));
  // Prefer a never-used code. Safe empty-entry reuse is only a fallback after
  // the usual fresh-code attempts, and still obeys all collision/distance checks.
  for (let phase = 0; phase < 2; phase += 1) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const compact = Array.from({ length: 4 }, () => ENTRY_CODE_ALPHABET[randomInt(ENTRY_CODE_ALPHABET.length)]).join("");
      if (phase === 0 && released.has(compact)) continue;
      if (blocked.some(row => [...compact].filter((char, index) => char !== row.entry_token[index]).length < 2)) continue;
      return compact;
    }
  }
  throw new Error("ENTRY_TOKEN_ALLOCATION_FAILED");
}
