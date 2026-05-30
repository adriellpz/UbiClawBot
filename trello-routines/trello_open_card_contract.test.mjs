import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenCardDescription,
  hasRequiredOpenCardSections,
} from "./trello_open_card_contract.mjs";

test("buildOpenCardDescription emits the required section order with blank Peer Review by default", () => {
  const desc = buildOpenCardDescription({
    originalRequest: "Review PR 42",
    research: ["PR: https://github.com/example/repo/pull/42", "Action: review_requested"],
  });

  assert.equal(hasRequiredOpenCardSections(desc), true);
  assert.match(desc, /Original Request:\nReview PR 42/);
  assert.match(desc, /Research:\nPR: https:\/\/github\.com\/example\/repo\/pull\/42/);
  assert.match(desc, /Peer Review:\n\nWork completed:/);
});

test("hasRequiredOpenCardSections rejects legacy partial bodies", () => {
  assert.equal(hasRequiredOpenCardSections("Original Request:\nReview package"), false);
});
