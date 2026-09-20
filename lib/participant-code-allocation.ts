import "server-only";

import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

type ParticipantCodePrefix = "P" | "T";

export async function createParticipantWithAvailableCode(
  client: PoolClient,
  experimentId: string,
  prefix: ParticipantCodePrefix,
  existingParticipantId?: string,
) {
  // Serialize allocations for one experiment and prefix. The lock lives until
  // the surrounding transaction commits or rolls back, so concurrent students
  // cannot select the same gap.
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`edulab:participant-code:${experimentId}:${prefix}`],
  );

  while (true) {
    const participant = await client.query<{ id: string; external_code: string }>(
      `WITH used_codes AS (
         SELECT DISTINCT substring(external_code FROM 2)::numeric AS number
         FROM participants
         WHERE experiment_id = $1
           AND external_code ~ ('^' || $2 || '[0-9]*[1-9][0-9]*$')
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
       , candidate AS (SELECT COALESCE(
         (SELECT expected FROM first_gap),
         (SELECT count(*)::bigint + 1 FROM ordered_codes),
         1
       )::text AS value)
       ${existingParticipantId ? `UPDATE participants SET external_code = $2 || lpad(candidate.value, GREATEST(3, length(candidate.value)), '0')
       FROM candidate WHERE id=$3 AND experiment_id=$1
       RETURNING id, external_code` : `INSERT INTO participants (id, experiment_id, external_code)
       SELECT $3, $1, $2 || lpad(value, GREATEST(3, length(value)), '0') FROM candidate
       ON CONFLICT (experiment_id, external_code) DO NOTHING
       RETURNING id, external_code`}`,
      [experimentId, prefix, existingParticipantId ?? randomUUID()],
    );
    if (participant.rows[0]) {
      return { participantId: participant.rows[0].id, participantCode: participant.rows[0].external_code };
    }
    if (existingParticipantId) throw new Error("PARTICIPANT_NOT_FOUND");
  }
}
