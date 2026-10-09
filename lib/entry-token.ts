import "server-only";
import { randomInt } from "node:crypto";
import type { PoolClient } from "pg";
import { ENTRY_CODE_ALPHABET } from "@/lib/entry-links";

export async function createRunEntryToken(client: PoolClient) {
  // Entry creation is rare. Serialize this short allocation only, ensuring
  // concurrent teachers cannot receive identical or nearly identical codes.
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('edulab:entry-links',0))");
  const existing = await client.query<{ entry_token: string }>(
    "SELECT entry_token FROM experiment_runs WHERE length(entry_token)=9");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const compact = Array.from({ length: 8 }, () => ENTRY_CODE_ALPHABET[randomInt(ENTRY_CODE_ALPHABET.length)]).join("");
    if (existing.rows.some((row) => {
      const previous = row.entry_token.replaceAll("-", "");
      return [...compact].filter((char, index) => char !== previous[index]).length < 4;
    })) continue;
    return `${compact.slice(0, 4)}-${compact.slice(4)}`;
  }
  throw new Error("ENTRY_TOKEN_ALLOCATION_FAILED");
}
