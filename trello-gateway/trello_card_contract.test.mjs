import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyContractOperation,
  evaluateContractWrite,
  validateCardSnapshot,
} from "./trello_card_contract.mjs";

function compliantDescription() {
  return [
    "Original Request:",
    "Ship the Trello contract.",
    "",
    "Research:",
    "Reviewed the gateway boundary and contract rules.",
    "",
    "Peer Review:",
    "",
    "Work completed:",
    "2026-05-25 MDT - Locked the validator scope.",
  ].join("\n");
}

function driftedDescription() {
  return [
    "Original Request:",
    "Ship the Trello contract.",
    "",
    "Research:",
    "Legacy body still has the wrong section.",
    "",
    "Next steps:",
    "Still in the description.",
    "",
    "Work completed:",
    "not dated",
  ].join("\n");
}

function cardState(overrides = {}) {
  return {
    listName: "Backlog",
    desc: compliantDescription(),
    checklists: [{ id: "chk-next", name: "Next steps" }],
    ...overrides,
  };
}

test("validateCardSnapshot accepts a compliant open-card body and Next steps checklist", () => {
  const result = validateCardSnapshot({
    desc: compliantDescription(),
    checklists: [{ id: "chk-next", name: "Next steps" }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.sections["Original Request"], "Ship the Trello contract.");
  assert.equal(result.sections["Research"], "Reviewed the gateway boundary and contract rules.");
  assert.equal(result.sections["Peer Review"], "");
  assert.equal(result.sections["Work completed"], "2026-05-25 MDT - Locked the validator scope.");
});

test("validateCardSnapshot rejects a card without the native Next steps checklist", () => {
  const result = validateCardSnapshot({
    desc: compliantDescription(),
    checklists: [{ id: "chk-other", name: "Follow-up" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "missing_next_steps_checklist");
});

test("validateCardSnapshot can require Peer Review to start blank on create", () => {
  const result = validateCardSnapshot({
    desc: compliantDescription().replace("Peer Review:\n", "Peer Review:\nAlready reviewed.\n"),
    checklists: [{ id: "chk-next", name: "Next steps" }],
  }, { requireBlankPeerReview: true });

  assert.equal(result.ok, false);
  assert.equal(result.code, "peer_review_must_start_blank");
});

test("validateCardSnapshot rejects reordered sections", () => {
  const reorderedDescription = [
    "Original Request:",
    "Ship the Trello contract.",
    "",
    "Work completed:",
    "2026-05-25 MDT - Locked the validator scope.",
    "",
    "Peer Review:",
    "",
    "Research:",
    "Reviewed the gateway boundary and contract rules.",
  ].join("\n");

  const result = validateCardSnapshot({
    desc: reorderedDescription,
    checklists: [{ id: "chk-next", name: "Next steps" }],
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_section_order");
});

test("classifyContractOperation distinguishes structural and safe writes", () => {
  assert.equal(classifyContractOperation({ operation: "comment" }).mode, "non_structural");
  assert.equal(classifyContractOperation({ operation: "move" }).mode, "structural");
  assert.equal(
    classifyContractOperation({ operation: "update", params: { fields: { name: "Retitle only" } } }).mode,
    "non_structural",
  );
  assert.equal(
    classifyContractOperation({ operation: "update", params: { fields: { desc: compliantDescription() } } }).mode,
    "structural",
  );
});

test("evaluateContractWrite rejects rewriting Original Request beyond typo cleanup", () => {
  const result = evaluateContractWrite({
    agentId: "main",
    classification: classifyContractOperation({
      operation: "update",
      params: { fields: { desc: compliantDescription().replace("Ship the Trello contract.", "Replace the whole request.") } },
    }),
    current: cardState(),
    next: cardState({
      desc: compliantDescription().replace("Ship the Trello contract.", "Replace the whole request."),
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "original_request_immutable");
});

test("evaluateContractWrite reserves non-blank Peer Review edits to Marcos", () => {
  const nextDesc = compliantDescription().replace("Peer Review:\n", "Peer Review:\nNeeds more tests.\n");

  const result = evaluateContractWrite({
    agentId: "main",
    classification: classifyContractOperation({
      operation: "update",
      params: { fields: { desc: nextDesc } },
    }),
    current: cardState(),
    next: cardState({ desc: nextDesc }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "peer_review_locked");
});

test("evaluateContractWrite enforces append-only Work completed entries", () => {
  const currentDesc = compliantDescription().replace(
    "2026-05-25 MDT - Locked the validator scope.",
    ["2026-05-25 MDT - Locked the validator scope.", "2026-05-26 MDT - Added enforcement."].join("\n"),
  );
  const nextDesc = currentDesc.replace("Added enforcement.", "Reworded enforcement.");

  const result = evaluateContractWrite({
    agentId: "main",
    classification: classifyContractOperation({
      operation: "update",
      params: { fields: { desc: nextDesc } },
    }),
    current: cardState({ desc: currentDesc }),
    next: cardState({ desc: nextDesc }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "work_completed_append_only");
});

test("evaluateContractWrite allows safe non-structural writes on a drifted card", () => {
  const result = evaluateContractWrite({
    agentId: "main",
    classification: classifyContractOperation({ operation: "comment" }),
    current: cardState({
      desc: driftedDescription(),
      checklists: [],
    }),
    next: cardState({
      desc: driftedDescription(),
      checklists: [],
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "non_structural");
});

test("evaluateContractWrite blocks structural non-repair writes on a drifted card", () => {
  const result = evaluateContractWrite({
    agentId: "main",
    classification: classifyContractOperation({ operation: "move" }),
    current: cardState({
      desc: driftedDescription(),
      checklists: [],
    }),
    next: cardState({
      listName: "Scheduled",
      desc: driftedDescription(),
      checklists: [],
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "card_requires_repair");
});

test("evaluateContractWrite allows structural repair on a drifted card", () => {
  const result = evaluateContractWrite({
    agentId: "main",
    classification: classifyContractOperation({
      operation: "update",
      params: { fields: { desc: compliantDescription() } },
    }),
    current: cardState({
      desc: driftedDescription(),
      checklists: [],
    }),
    next: cardState(),
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "repair");
});
