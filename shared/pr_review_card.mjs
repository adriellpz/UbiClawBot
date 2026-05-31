/** Cards created by github-pr-bridge use titles like `P2 - Review PR 14`. */
const PR_REVIEW_CARD_NAME_RE = /\bReview PR\s*#?\d+\b/i;

export function isPrReviewCard({ cardName = "", text = "" } = {}) {
  const name = cardName || text;
  return PR_REVIEW_CARD_NAME_RE.test(name);
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function cardExactlyMatchesPr(card, prNumber, prUrl) {
  const name = String(card?.name || "");
  const desc = String(card?.desc || "");
  const hasExactPrName = new RegExp(`\\bPR\\s*#?${prNumber}\\b`, "i").test(name);
  const hasExactPrReference =
    new RegExp(`${escapeRegExp(prUrl)}([^0-9]|$)`).test(desc) ||
    new RegExp(`(^|[^0-9])/pull/${prNumber}([^0-9]|$)`).test(desc);
  return hasExactPrName || hasExactPrReference;
}

export function buildPrReviewSearchQuery(prNumber, boardId) {
  return boardId ? `/pull/${prNumber} board:${boardId}` : `/pull/${prNumber}`;
}

export function normalizeDoneListNames(doneListNames = ["done"]) {
  return new Set(
    (Array.isArray(doneListNames) ? doneListNames : [doneListNames])
      .map((name) => String(name || "").trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isDoneListName(listName, doneListNames) {
  return normalizeDoneListNames(doneListNames).has(String(listName || "").trim().toLowerCase());
}

/** Prefer an active (non-Done) card; reuse Done cards before creating a new one. */
export function selectCanonicalPrReviewCard(cards, { doneListNames = ["done"] } = {}) {
  const open = (Array.isArray(cards) ? cards : []).filter((card) => !card?.closed);
  if (open.length === 0) return { canonical: null, duplicates: [] };

  const active = open.filter((card) => !isDoneListName(card.listName, doneListNames));
  const pool = active.length > 0 ? active : open;
  const canonical = pool[0];
  const duplicates =
    active.length > 0 ? open.filter((card) => card.id !== canonical.id) : open.filter((card) => card.id !== canonical.id);

  return { canonical, duplicates };
}

export function duplicateReviewCardComment(canonicalUrl) {
  return `Duplicate PR review card — track updates on ${canonicalUrl}`;
}
