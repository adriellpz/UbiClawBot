import assert from "node:assert/strict";
import test from "node:test";

import { toHandlerResult } from "./handle_reschedule.mjs";

test("toHandlerResult: calendar_search_failed is retryable", () => {
  const result = toHandlerResult({
    status: "warning",
    message: "calendar_search_failed",
    error: "ENOENT",
    card: "P2 - Task",
  });
  assert.equal(result.ok, false);
  assert.equal(result.message, "calendar_search_failed");
});

test("toHandlerResult: successful reschedule is handled", () => {
  const result = toHandlerResult({ status: "ok", action: "moved_event", card: "P2 - Task" });
  assert.equal(result.ok, true);
});

test("toHandlerResult: escalated_no_slot is handled (human notified)", () => {
  const result = toHandlerResult({ status: "ok", action: "escalated_no_slot", card: "P2 - Task" });
  assert.equal(result.ok, true);
});

test("toHandlerResult: protected routine skip is handled", () => {
  const result = toHandlerResult({ status: "skipped", reason: "protected_routine_constraint", card: "Dog walk" });
  assert.equal(result.ok, true);
});

test("toHandlerResult: closed card skip is handled", () => {
  const result = toHandlerResult({ status: "skipped", reason: "card_closed", card: "P2 - Task" });
  assert.equal(result.ok, true);
});
