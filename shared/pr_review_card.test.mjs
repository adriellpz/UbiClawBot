import assert from "node:assert/strict";
import test from "node:test";

import { isPrReviewCard } from "./pr_review_card.mjs";

test("isPrReviewCard matches github-pr-bridge card titles", () => {
  assert.equal(isPrReviewCard({ cardName: "P2 - Review PR 14" }), true);
  assert.equal(isPrReviewCard({ cardName: "Review PR #52" }), true);
  assert.equal(isPrReviewCard({ cardName: "Buy dog food" }), false);
  assert.equal(isPrReviewCard({ text: "P1 - Review PR 3" }), true);
});
