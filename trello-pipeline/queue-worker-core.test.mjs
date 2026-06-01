import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { dispatch } from "./queue-worker-core.mjs";

function tmpState() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qwcore-"));
}

function fakeCard(overrides = {}) {
  return { id: "card-1", name: "P2 - Do a thing", shortUrl: "https://trello.com/c/card-1", shortLink: "card-1", closed: false, ...overrides };
}

function entry(overrides = {}) {
  return { actionId: "action-1", kind: "trello_card_moved_to_reschedule", cardId: "card-1", fromListName: "Backlog", ...overrides };
}

test("dispatch: calls matching handler run() with the fetched card", async () => {
  const stateDir = tmpState();
  const card = fakeCard();
  const calls = [];
  const handlerMap = {
    trello_card_moved_to_reschedule: { run: async (c, ctx) => { calls.push({ card: c, ctx }); return { ok: true }; } },
  };

  await dispatch(entry(), handlerMap, { getCard: async () => card, stateDir });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].card, card);
});

test("dispatch: closed card — handler never called, entry marked handled", async () => {
  const stateDir = tmpState();
  const calls = [];
  const handlerMap = {
    trello_card_moved_to_reschedule: { run: async () => { calls.push(true); return { ok: true }; } },
  };

  await dispatch(entry(), handlerMap, { getCard: async () => fakeCard({ closed: true }), stateDir });

  assert.equal(calls.length, 0);
  const handled = JSON.parse(fs.readFileSync(path.join(stateDir, "actionable_handled_ids.json"), "utf8"));
  assert.ok(handled.includes("action-1"));
});

test("dispatch: unknown kind — no handler called, entry marked handled", async () => {
  const stateDir = tmpState();
  const calls = [];
  const handlerMap = {
    trello_card_moved_to_reschedule: { run: async () => { calls.push(true); return { ok: true }; } },
  };

  await dispatch(entry({ kind: "some_unhandled_event" }), handlerMap, { getCard: async () => fakeCard(), stateDir });

  assert.equal(calls.length, 0);
  const handled = JSON.parse(fs.readFileSync(path.join(stateDir, "actionable_handled_ids.json"), "utf8"));
  assert.ok(handled.includes("action-1"));
});

test("dispatch: ctx carries fromListName and actionId to handler", async () => {
  const stateDir = tmpState();
  let receivedCtx;
  const handlerMap = {
    trello_card_moved_to_reschedule: { run: async (_card, ctx) => { receivedCtx = ctx; return { ok: true }; } },
  };

  await dispatch(
    entry({ actionId: "action-42", fromListName: "Reschedule" }),
    handlerMap,
    { getCard: async () => fakeCard(), stateDir },
  );

  assert.equal(receivedCtx.actionId, "action-42");
  assert.equal(receivedCtx.fromListName, "Reschedule");
});

test("dispatch: handler failure — records failure, entry NOT marked handled", async () => {
  const stateDir = tmpState();
  const handlerMap = {
    trello_card_moved_to_reschedule: { run: async () => ({ ok: false, stderr: "something went wrong" }) },
  };

  await dispatch(entry(), handlerMap, { getCard: async () => fakeCard(), stateDir });

  // Not marked handled — will be retried next tick
  const handledFile = path.join(stateDir, "actionable_handled_ids.json");
  const handled = fs.existsSync(handledFile)
    ? JSON.parse(fs.readFileSync(handledFile, "utf8"))
    : [];
  assert.ok(!handled.includes("action-1"), "failed entry should not be marked handled");

  // Failure recorded
  const failures = JSON.parse(fs.readFileSync(path.join(stateDir, "handler_failures.json"), "utf8"));
  assert.equal(failures["action-1"].count, 1);
});

test("dispatch: max attempts exceeded — entry marked handled (gives up)", async () => {
  const stateDir = tmpState();
  const calls = [];
  const handlerMap = {
    trello_card_moved_to_reschedule: { run: async () => { calls.push(true); return { ok: true }; } },
  };

  // Pre-seed failure record at MAX_HANDLER_ATTEMPTS (default 5)
  const failuresFile = path.join(stateDir, "handler_failures.json");
  fs.writeFileSync(failuresFile, JSON.stringify({ "action-1": { count: 5, lastAt: new Date().toISOString() } }));

  await dispatch(entry(), handlerMap, { getCard: async () => fakeCard(), stateDir });

  // Handler should never be called
  assert.equal(calls.length, 0);

  // Entry should be marked handled (gave up)
  const handled = JSON.parse(fs.readFileSync(path.join(stateDir, "actionable_handled_ids.json"), "utf8"));
  assert.ok(handled.includes("action-1"));
});
