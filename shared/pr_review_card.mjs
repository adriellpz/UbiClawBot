/** Cards created by github-pr-bridge use titles like `P2 - Review PR 14`. */
const PR_REVIEW_CARD_NAME_RE = /\bReview PR\s*#?\d+\b/i;

export function isPrReviewCard({ cardName = "", text = "" } = {}) {
  const name = cardName || text;
  return PR_REVIEW_CARD_NAME_RE.test(name);
}
