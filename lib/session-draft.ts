import "server-only";

import { query } from "@/db";

export async function getSessionDraft(sessionId: string) {
  const result = await query<{ draft_text: string; draft_revision: number }>(
    "SELECT draft_text, draft_revision FROM experiment_sessions WHERE id=$1", [sessionId],
  );
  return { text: result.rows[0]?.draft_text ?? "", revision: result.rows[0]?.draft_revision ?? 0 };
}
