import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import process from "node:process";
import pg from "pg";

const username = process.argv[2]?.trim().toLowerCase();
const password = process.env.EDULAB_ADMIN_PASSWORD;
const displayName = process.env.EDULAB_ADMIN_NAME?.trim() || username;
if (!username || !/^[a-z0-9._-]{2,64}$/.test(username)) throw new Error("Provide a username: npm run admin:create -- researcher");
if (!password || password.length < 12) throw new Error("EDULAB_ADMIN_PASSWORD must contain at least 12 characters");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const salt = randomBytes(16);
const hash = scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const encoded = `scrypt$${salt.toString("base64url")}$${hash.toString("base64url")}`;
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "disable" ? false : process.env.DATABASE_SSL === "require" ? { rejectUnauthorized: true } : undefined,
});

await client.connect();
try {
  await client.query(
    `INSERT INTO admin_users (id, username, password_hash, display_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash,
       display_name = EXCLUDED.display_name, is_active = true, failed_login_count = 0,
       locked_until = NULL, updated_at = now()`,
    [randomUUID(), username, encoded, displayName],
  );
  process.stdout.write(`Administrator ${username} is ready.\n`);
} finally {
  await client.end();
}
