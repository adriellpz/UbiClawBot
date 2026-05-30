import test from "node:test";
import assert from "node:assert/strict";
import { isEmailHookCard } from "./email_hook_card.mjs";

test("isEmailHookCard matches gmail-hook-bridge card titles", () => {
  assert.equal(isEmailHookCard({ cardName: "P2 - Email: Schedule dentist" }), true);
  assert.equal(isEmailHookCard({ cardName: "P1 - Email: Urgent follow-up" }), true);
  assert.equal(isEmailHookCard({ cardName: "Buy dog food" }), false);
  assert.equal(isEmailHookCard({ text: "P2 - Email: hello" }), true);
});
