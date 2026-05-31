import assert from "node:assert/strict";
import test from "node:test";

import {
  cardListName,
  needsRoutineBeforeMissed,
  shouldRoutineMissedDuplicate,
} from "./handle_reschedule_logic.mjs";

test("cardListName reads list name from gateway card payload", () => {
  assert.equal(cardListName({ list: { name: "Reschedule" } }), "reschedule");
  assert.equal(cardListName({}), "");
});

test("shouldRoutineMissedDuplicate when routine origin and tomorrow event exists", () => {
  assert.equal(shouldRoutineMissedDuplicate("routine", true), true);
  assert.equal(shouldRoutineMissedDuplicate("routine", false), false);
  assert.equal(shouldRoutineMissedDuplicate("scheduled", true), false);
});

test("needsRoutineBeforeMissed when card is in Reschedule queue", () => {
  assert.equal(needsRoutineBeforeMissed({ list: { name: "Reschedule" } }), true);
  assert.equal(needsRoutineBeforeMissed({ list: { name: "Routine" } }), false);
});
