import assert from "node:assert/strict";
import test from "node:test";

import { cardListName, shouldRoutineMissedDuplicate } from "./handle_reschedule_logic.mjs";

test("cardListName reads list name from gateway card payload", () => {
  assert.equal(cardListName({ list: { name: "Reschedule" } }), "reschedule");
  assert.equal(cardListName({}), "");
});

test("shouldRoutineMissedDuplicate allows Missed only from Routine list", () => {
  assert.equal(shouldRoutineMissedDuplicate({ list: { name: "Routine" } }), true);
  assert.equal(shouldRoutineMissedDuplicate({ list: { name: "Reschedule" } }), false);
  assert.equal(shouldRoutineMissedDuplicate({ list: { name: "Scheduled" } }), false);
});
