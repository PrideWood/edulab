import "server-only";

import type { PoolClient } from "pg";
import { query } from "@/db";
import type { AuthenticatedSession } from "@/lib/session";

// Legacy runtime cookies may have counted turns before their browser
// transcript was uploaded. Preserve that known count, while counting later
// server requests normally. Uploading old turns must not double-count them.
export async function getSessionUsage(session: AuthenticatedSession, client?: PoolClient) {
  const sql = `WITH family AS (
    SELECT id, started_at, metadata FROM experiment_sessions
    WHERE participant_id=$1 AND experiment_id=$2 AND session_secret_hash=$3
  ), legacy AS (
    SELECT (metadata->'legacy_usage_floor'->>'count')::bigint AS count,
      (metadata->'legacy_usage_floor'->>'through')::timestamptz AS through
    FROM family WHERE metadata ? 'legacy_usage_floor'
    ORDER BY (metadata->'legacy_usage_floor'->>'through')::timestamptz DESC LIMIT 1
  ) SELECT (GREATEST(
      count(r.id) FILTER (WHERE legacy.through IS NULL OR r.requested_at <= legacy.through),
      COALESCE(max(legacy.count), 0))
      + count(r.id) FILTER (WHERE legacy.through IS NOT NULL AND r.requested_at > legacy.through))::text AS count,
    min(s.started_at)::text AS started_at
    FROM family s LEFT JOIN chat_requests r ON r.session_id=s.id LEFT JOIN legacy ON true`;
  const values = [session.participantId, session.experimentId, session.sessionSecretHash];
  const result = client
    ? await client.query<{ count: string; started_at: string | null }>(sql, values)
    : await query<{ count: string; started_at: string | null }>(sql, values);
  return { count: Number(result.rows[0]?.count ?? 0), startedAt: result.rows[0]?.started_at ?? session.startedAt };
}
