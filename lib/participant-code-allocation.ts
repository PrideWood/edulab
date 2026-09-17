import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { formatParticipantCode } from "@/lib/participant-code";

type ParticipantCodePrefix = "P" | "T";

export async function createParticipantWithAvailableCode(
  client: PoolClient,
  experimentId: string,
  prefix: ParticipantCodePrefix,
) {
  // Serialize allocations for one experiment and prefix. The lock lives until
  // the surrounding transaction commits or rolls back, so concurrent students
  // cannot select the same gap.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`edulab:participant-code:${experimentId}:${prefix}`],
  );

  while (true) {
    const available = await client.query<{ value: string }>(
      `WITH used_codes AS (
         SELECT DISTINCT substring(external_code FROM 2)::bigint AS number
         FROM participants
         WHERE experiment_id = $1
           AND external_code ~ ('^' || $2 || '[0-9]+$')
           AND substring(external_code FROM 2)::bigint > 0
       ), ordered_codes AS (
         SELECT number, row_number() OVER (ORDER BY number)::bigint AS expected
         FROM used_codes
       ), first_gap AS (
         SELECT expected
         FROM ordered_codes
         WHERE number <> expected
         ORDER BY expected
         LIMIT 1
       )
       SELECT COALESCE(
         (SELECT expected FROM first_gap),
         (SELECT count(*)::bigint + 1 FROM ordered_codes),
         1
       )::text AS value`,
      [experimentId, prefix],
    );
    const participantCode = formatParticipantCode(prefix, available.rows[0]?.value ?? 1);
    const participant = await client.query<{ id: string }>(
      `INSERT INTO participants (id, experiment_id, external_code) VALUES ($1, $2, $3)
       ON CONFLICT (experiment_id, external_code) DO NOTHING
       RETURNING id`,
      [randomUUID(), experimentId, participantCode],
    );
    if (participant.rows[0]) {
      return { participantId: participant.rows[0].id, participantCode };
    }
  }
}
