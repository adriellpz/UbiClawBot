import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPrReviewSearchQuery,
  cardExactlyMatchesPr,
  duplicateReviewCardComment,
  isDoneListName,
  isPrReviewCard,
  selectCanonicalPrReviewCard,
} from "./pr_review_card.mjs";

test("isPrReviewCard matches github-pr-bridge card titles", () => {
  assert.equal(isPrReviewCard({ cardName: "P2 - Review PR 14" }), true);
  assert.equal(isPrReviewCard({ cardName: "Review PR #52" }), true);
  assert.equal(isPrReviewCard({ cardName: "Buy dog food" }), false);
  assert.equal(isPrReviewCard({ text: "P1 - Review PR 3" }), true);
});

test("cardExactlyMatchesPr matches title or PR URL in description", () => {
  const prUrl = "https://github.com/adriellpz/UbiClawBot/pull/69";
  assert.equal(cardExactlyMatchesPr({ name: "P2 - Review PR 69", desc: "" }, 69, prUrl), true);
  assert.equal(
    cardExactlyMatchesPr({ name: "Other card", desc: `PR: ${prUrl}` }, 69, prUrl),
    true,
  );
  assert.equal(cardExactlyMatchesPr({ name: "P2 - Review PR 70", desc: "" }, 69, prUrl), false);
});

test("buildPrReviewSearchQuery scopes to board when configured", () => {
  assert.equal(buildPrReviewSearchQuery(14, "board123"), "/pull/14 board:board123");
  assert.equal(buildPrReviewSearchQuery(14, ""), "/pull/14");
});

test("selectCanonicalPrReviewCard prefers active cards over Done", () => {
  const done = { id: "done-1", closed: false, listName: "Done", url: "https://trello.com/c/done-1" };
  const active = { id: "active-1", closed: false, listName: "Backlog", url: "https://trello.com/c/active-1" };
  const result = selectCanonicalPrReviewCard([done, active]);
  assert.equal(result.canonical.id, "active-1");
  assert.deepEqual(
    result.duplicates.map((card) => card.id),
    ["done-1"],
  );
});

test("selectCanonicalPrReviewCard reuses Done card when no active card exists", () => {
  const doneA = { id: "done-a", closed: false, listName: "Done", url: "https://trello.com/c/done-a" };
  const doneB = { id: "done-b", closed: false, listName: "Done", url: "https://trello.com/c/done-b" };
  const result = selectCanonicalPrReviewCard([doneA, doneB]);
  assert.equal(result.canonical.id, "done-a");
  assert.deepEqual(
    result.duplicates.map((card) => card.id),
    ["done-b"],
  );
});

test("selectCanonicalPrReviewCard marks extra active cards as duplicates", () => {
  const first = { id: "card-1", closed: false, listName: "Backlog", url: "https://trello.com/c/1" };
  const second = { id: "card-2", closed: false, listName: "Review", url: "https://trello.com/c/2" };
  const result = selectCanonicalPrReviewCard([first, second]);
  assert.equal(result.canonical.id, "card-1");
  assert.deepEqual(
    result.duplicates.map((card) => card.id),
    ["card-2"],
  );
});

test("isDoneListName respects configured done lists", () => {
  assert.equal(isDoneListName("Done", ["Done"]), true);
  assert.equal(isDoneListName("Backlog", ["Done"]), false);
});

test("duplicateReviewCardComment points at the canonical card", () => {
  assert.match(duplicateReviewCardComment("https://trello.com/c/abc"), /https:\/\/trello\.com\/c\/abc/);
});
