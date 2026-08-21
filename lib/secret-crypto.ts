import "server-only";

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export interface EncryptedSecret {
  ciphertext: string;
  iv: string;
  tag: string;
}

function encryptionKey() {
  const configured = process.env.SETTINGS_ENCRYPTION_KEY;
  if (!configured || configured.length < 32) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured");
  return createHash("sha256").update(configured).digest();
}

export function encryptSecret(value: string): EncryptedSecret {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return { ciphertext: ciphertext.toString("base64"), iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64") };
}

export function decryptSecret(input: EncryptedSecret) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(input.iv, "base64"));
  decipher.setAuthTag(Buffer.from(input.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(input.ciphertext, "base64")), decipher.final()]).toString("utf8");
}
