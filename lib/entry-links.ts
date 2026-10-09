// Exclude 0/1/i/l/o so classroom entry codes are easier to transcribe.
export const ENTRY_CODE_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function normalizeEntryToken(value: string) {
  const token = value.trim().toLowerCase();
  if (/^[a-f0-9]{32}$/.test(token)) return token; // Existing links remain valid.
  const compact = token.replaceAll("-", "");
  if (compact.length !== 8 || [...compact].some((char) => !ENTRY_CODE_ALPHABET.includes(char))) return null;
  return `${compact.slice(0, 4)}-${compact.slice(4)}`;
}

export function buildEntryInvitation(input: {
  experimentName: string;
  groupName: string;
  assignmentMode: "fixed" | "balanced_random";
  agentNames: string[];
  url: string;
}) {
  return `实验：${input.experimentName}\n分组：${input.groupName}\n智能体：${input.agentNames.join("、")}\n分配方式：${input.assignmentMode === "fixed" ? "固定智能体" : "均衡随机分配"}\n实验链接：${input.url}`;
}
