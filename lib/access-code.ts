export const ACCESS_COOKIE = "edulab_access";
export const ACCESS_COOKIE_MAX_AGE = 60 * 60 * 24 * 7;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalText(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function digest(value: string) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

export async function verifySubmittedAccessCode(submitted: string, configured: string) {
  const [submittedDigest, configuredDigest] = await Promise.all([digest(submitted), digest(configured)]);
  return equalText(submittedDigest, configuredDigest);
}

export async function createAccessCookieValue(accessCode: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(accessCode),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode("edulab-access-v1"));
  return `v1.${toHex(new Uint8Array(signature))}`;
}

export async function verifyAccessCookie(value: string | undefined, accessCode: string) {
  if (!value?.startsWith("v1.")) return false;
  const expected = await createAccessCookieValue(accessCode);
  return equalText(value, expected);
}
