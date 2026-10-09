import "server-only";

import type { PoolClient } from "pg";
import { transaction } from "@/db";
import { ApiError } from "@/lib/http";
import type { AuthenticatedSession } from "@/lib/session";

// Recovery takes the same participant lock before rotating the session family
// secret. A stale browser cannot write after a successful recovery.
export async function sessionTransaction<T>(session: AuthenticatedSession, work: (client: PoolClient) => Promise<T>) {
  return transaction(async (client) => {
    await client.query("SELECT id FROM participants WHERE id=$1 FOR UPDATE", [session.participantId]);
    const authorized = await client.query(
      "SELECT id FROM experiment_sessions WHERE id=$1 AND session_secret_hash=$2",
      [session.id, session.sessionSecretHash],
    );
    if (!authorized.rows[0]) throw new ApiError(401, "SESSION_REPLACED", "此编号已在其他窗口恢复，请使用最近恢复的窗口继续实验。");
    return work(client);
  });
}
