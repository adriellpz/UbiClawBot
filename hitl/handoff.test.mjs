import assert from "node:assert/strict";
import test from "node:test";

import { hitlHandoff } from "./handoff.mjs";

function makeTelegram() {
  const sent = [];
  return {
    sent,
    send: async (msg) => { sent.push(msg); },
  };
}

function makeRegistry() {
  let counter = 0;
  const callbacks = new Map();
  return {
    assign({ resolve }) {
      const n = ++counter;
      callbacks.set(n, resolve);
      return n;
    },
    resolve(n) {
      callbacks.get(n)?.();
      callbacks.delete(n);
    },
    get(n) {
      return callbacks.has(n) ? { n } : undefined;
    },
  };
}

test("happy path: sends Telegram message with session number and liveUrl, resolves when DOM condition clears", async () => {
  const telegram = makeTelegram();
  const registry = makeRegistry();

  let pollCount = 0;
  const domPoller = async () => {
    pollCount++;
    return pollCount >= 2; // resolves on 2nd poll
  };

  const liveUrl = "https://browser.example.com/session/abc";

  await hitlHandoff({
    liveUrl,
    jobContext: { company: "Stripe", role: "Senior Engineer" },
    telegram,
    registry,
    domPoller,
    pollIntervalMs: 0,
    pollTimeoutMs: 5000,
  });

  assert.ok(telegram.sent.length >= 1, "should send at least one Telegram message");
  const firstMsg = telegram.sent[0];
  assert.match(firstMsg, /HITL #1/, "message should include session number");
  assert.match(firstMsg, /Stripe/, "message should include company");
  assert.match(firstMsg, /Senior Engineer/, "message should include role");
  assert.ok(firstMsg.includes(liveUrl), "message should include live URL");
  assert.equal(pollCount >= 2, true, "should have polled at least twice");
});

test("Telegram fallback: sends '⚠️ N done' message when DOM polling times out, then resolves when registry resolves the session", async () => {
  const telegram = makeTelegram();
  const registry = makeRegistry();

  const domPoller = async () => false; // never resolves

  const liveUrl = "https://browser.example.com/session/xyz";

  const handoffPromise = hitlHandoff({
    liveUrl,
    jobContext: { company: "Acme", role: "PM" },
    telegram,
    registry,
    domPoller,
    pollIntervalMs: 0,
    pollTimeoutMs: 0, // immediate timeout
  });

  // After timeout, the fallback message is sent and it waits for registry.resolve
  // Simulate operator replying "1 done"
  await Promise.resolve(); // let microtasks run
  registry.resolve(1);

  await handoffPromise;

  assert.equal(telegram.sent.length, 2, "should send initial message + fallback");
  assert.match(telegram.sent[0], /HITL #1.*Acme.*PM/);
  assert.match(telegram.sent[1], /⚠️ HITL #1.*1 done/);
});

test("concurrent sessions get distinct session numbers and resolve independently", async () => {
  const telegram = makeTelegram();
  const registry = makeRegistry();

  // Session 1: DOM resolves on 2nd poll
  let poll1Count = 0;
  const domPoller1 = async () => { poll1Count++; return poll1Count >= 2; };

  // Session 2: DOM never resolves (will be resolved via registry externally)
  const domPoller2 = async () => false;

  const handoff1 = hitlHandoff({
    liveUrl: "https://browser.example.com/s/1",
    jobContext: { company: "Stripe", role: "Engineer" },
    telegram,
    registry,
    domPoller: domPoller1,
    pollIntervalMs: 0,
    pollTimeoutMs: 5000,
  });

  const handoff2 = hitlHandoff({
    liveUrl: "https://browser.example.com/s/2",
    jobContext: { company: "Acme", role: "PM" },
    telegram,
    registry,
    domPoller: domPoller2,
    pollIntervalMs: 0,
    pollTimeoutMs: 0, // timeout immediately, send fallback
  });

  // Resolve session 2 externally while session 1 is still resolving on its own
  registry.resolve(2);

  await Promise.all([handoff1, handoff2]);

  const nums = telegram.sent
    .map((m) => m.match(/HITL #(\d+)/)?.[1])
    .filter(Boolean)
    .map(Number);

  assert.ok(nums.includes(1), "session 1 message should reference #1");
  assert.ok(nums.includes(2), "session 2 message should reference #2");
  assert.notEqual(nums[0], nums[1], "first two session numbers must differ");
});
