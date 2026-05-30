/** Cards created by gog-canary-bridge use titles like `P1 - GOG Auth: re-auth needed`. */
const GOG_CANARY_CARD_NAME_RE = /-\s*GOG Auth:\s/i;

export function isGogCanaryCard({ cardName = "", text = "" } = {}) {
  const name = cardName || text;
  return GOG_CANARY_CARD_NAME_RE.test(name);
}
