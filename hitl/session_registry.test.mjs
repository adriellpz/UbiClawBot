import assert from "node:assert/strict";
import test from "node:test";

import { SessionRegistry } from "./session_registry.mjs";

test("assign returns incrementing session numbers starting at 1", () => {
  const registry = new SessionRegistry();
  const n1 = registry.assign({ company: "Stripe", role: "Engineer", liveUrl: "https://x/1" });
  const n2 = registry.assign({ company: "Acme", role: "PM", liveUrl: "https://x/2" });
  assert.equal(n1, 1);
  assert.equal(n2, 2);
});

test("resolve calls the registered resolve callback and removes session", () => {
  const registry = new SessionRegistry();
  let called = false;
  const n = registry.assign({ company: "Stripe", role: "Engineer", liveUrl: "https://x/1", resolve: () => { called = true; } });
  registry.resolve(n);
  assert.equal(called, true);
  assert.equal(registry.get(n), undefined);
});

test("resolve with unknown session number is a no-op", () => {
  const registry = new SessionRegistry();
  assert.doesNotThrow(() => registry.resolve(99));
});

test("get returns the session context for an assigned number", () => {
  const registry = new SessionRegistry();
  const n = registry.assign({ company: "Stripe", role: "Engineer", liveUrl: "https://x/1" });
  const session = registry.get(n);
  assert.equal(session.company, "Stripe");
  assert.equal(session.role, "Engineer");
  assert.equal(session.liveUrl, "https://x/1");
});

test("get returns undefined for unknown session number", () => {
  const registry = new SessionRegistry();
  assert.equal(registry.get(999), undefined);
});

test("concurrent sessions get distinct numbers and resolve independently", () => {
  const registry = new SessionRegistry();
  const resolved = [];
  const n1 = registry.assign({ company: "A", role: "Dev", liveUrl: "u1", resolve: () => resolved.push(1) });
  const n2 = registry.assign({ company: "B", role: "PM", liveUrl: "u2", resolve: () => resolved.push(2) });

  registry.resolve(n2);
  assert.deepEqual(resolved, [2]);
  assert.ok(registry.get(n1), "session 1 should still be active");
  assert.equal(registry.get(n2), undefined, "session 2 should be gone");

  registry.resolve(n1);
  assert.deepEqual(resolved, [2, 1]);
});
