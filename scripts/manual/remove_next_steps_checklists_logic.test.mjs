import assert from "node:assert/strict";
import test from "node:test";

import {
  findNextStepsChecklists,
  planNextStepsRemoval,
  shouldSkipCardForSweep,
} from "./remove_next_steps_checklists_logic.mjs";

test("shouldSkipCardForSweep skips Done and closed cards", () => {
  assert.equal(shouldSkipCardForSweep({ closed: false }, "Done"), true);
  assert.equal(shouldSkipCardForSweep({ closed: true }, "Backlog"), true);
  assert.equal(shouldSkipCardForSweep({ closed: false }, "Backlog"), false);
});

test("findNextStepsChecklists matches exact checklist name", () => {
  assert.deepEqual(
    findNextStepsChecklists([
      { id: "a", name: "Next steps" },
      { id: "b", name: "Follow-up" },
    ]).map((entry) => entry.id),
    ["a"],
  );
});

test("planNextStepsRemoval deletes Next steps on open scoped cards only", () => {
  const result = planNextStepsRemoval([
    {
      card: { id: "c1", name: "Open task", closed: false },
      listName: "Backlog",
      checklists: [{ id: "chk1", name: "Next steps" }],
    },
    {
      card: { id: "c2", name: "Finished task", closed: false },
      listName: "Done",
      checklists: [{ id: "chk2", name: "Next steps" }],
    },
    {
      card: { id: "c3", name: "Archived task", closed: true },
      listName: "Backlog",
      checklists: [{ id: "chk3", name: "Next steps" }],
    },
  ]);

  assert.equal(result.toDelete.length, 1);
  assert.equal(result.toDelete[0].checklistId, "chk1");
  assert.equal(result.skipped.length, 2);
});
