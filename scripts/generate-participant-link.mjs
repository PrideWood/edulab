import { createHmac } from "node:crypto";
import process from "node:process";

const secret = process.env.PARTICIPANT_LINK_SECRET;
if (!secret) throw new Error("PARTICIPANT_LINK_SECRET is required");

const experimentId = process.env.EXPERIMENT_ID ?? "learning-scenario-v1";
const baseUrl = (process.env.EDULAB_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const codes = process.argv.slice(2);
if (!codes.length) throw new Error("Provide one or more participant codes, for example: P001 P002");

for (const rawCode of codes) {
  const code = rawCode.trim().toUpperCase();
  const access = createHmac("sha256", secret).update(`${experimentId}:${code}`).digest("base64url");
  process.stdout.write(`${code}\t${baseUrl}/?participant=${encodeURIComponent(code)}&access=${encodeURIComponent(access)}\n`);
}
