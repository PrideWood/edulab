const TEST_PARTICIPANT_NAMES = new Set(["测试", "ceshi", "test"]);

/**
 * Test identities require an exact normalized name match. Student numbers and
 * partial name matches intentionally do not affect participant numbering.
 * @param {string} fullName
 */
export function isTestParticipantName(fullName) {
  return TEST_PARTICIPANT_NAMES.has(fullName.trim().toLocaleLowerCase("en-US"));
}

/**
 * @param {"P" | "T"} prefix
 * @param {string | number | bigint} value
 */
export function formatParticipantCode(prefix, value) {
  return `${prefix}${String(value).padStart(3, "0")}`;
}
