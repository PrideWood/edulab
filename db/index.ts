import "server-only";

import { Pool, type PoolClient, type QueryResultRow } from "pg";

declare global {
  var edulabPool: Pool | undefined;
}

function createPool() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not configured");
  return new Pool({
    connectionString,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 20_000,
    connectionTimeoutMillis: 10_000,
    ssl: process.env.DATABASE_SSL === "disable" ? false : process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
  });
}

export function getPool() {
  if (!globalThis.edulabPool) globalThis.edulabPool = createPool();
  return globalThis.edulabPool;
}

export async function query<T extends QueryResultRow>(text: string, values: unknown[] = []) {
  return getPool().query<T>(text, values);
}

export async function transaction<T>(work: (client: PoolClient) => Promise<T>) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
