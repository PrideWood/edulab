import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import pg from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");

const client = new pg.Client({
  connectionString,
  ssl: process.env.DATABASE_SSL === "disable" ? false : process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
});

await client.connect();
try {
  await client.query(`CREATE TABLE IF NOT EXISTS edulab_schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const directory = path.join(process.cwd(), "db", "migrations");
  const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files) {
    const applied = await client.query("SELECT 1 FROM edulab_schema_migrations WHERE name = $1", [name]);
    if (applied.rowCount) continue;
    const sql = await readFile(path.join(directory, name), "utf8");
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO edulab_schema_migrations (name) VALUES ($1)", [name]);
      await client.query("COMMIT");
      process.stdout.write(`Applied ${name}\n`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
} finally {
  await client.end();
}
