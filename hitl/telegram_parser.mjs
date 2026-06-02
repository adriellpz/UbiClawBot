const DONE_PATTERN = /^(\d+)\s+done$/i;

export function parseDoneReply(text) {
  const match = DONE_PATTERN.exec(text.trim());
  if (!match) return null;
  return Number(match[1]);
}
