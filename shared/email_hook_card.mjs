/** Cards created by gmail-hook-bridge use titles like `P2 - Email: Subject line`. */
const EMAIL_HOOK_CARD_NAME_RE = /-\s*Email:\s/i;

export function isEmailHookCard({ cardName = "", text = "" } = {}) {
  const name = cardName || text;
  return EMAIL_HOOK_CARD_NAME_RE.test(name);
}
