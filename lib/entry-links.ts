// Exclude 0/1/i/l/o so classroom entry codes are easier to transcribe.
export const ENTRY_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function normalizeEntryToken(value: string) {
  const token = value.trim().toLowerCase();
  if (token.length === 4 && [...token].every((char) => ENTRY_CODE_ALPHABET.includes(char))) return token;
  if (/^[a-f0-9]{32}$/.test(token)) return token; // Existing links remain valid.
  const compact = token.replaceAll("-", "");
  if (compact.length !== 8 || [...compact].some((char) => !ENTRY_CODE_ALPHABET.includes(char))) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function buildEntryInvitation(input: {
  label: string;
  url: string;
}) {
  return `${input.label}\n${input.url}`;
}
