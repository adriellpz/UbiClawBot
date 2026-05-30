import test from "node:test";
import assert from "node:assert/strict";
import { isGogCanaryCard } from "./gog_canary_card.mjs";

test("isGogCanaryCard matches gog-canary-bridge card titles", () => {
  assert.equal(isGogCanaryCard({ cardName: "P1 - GOG Auth: ubitheai re-auth needed" }), true);
  assert.equal(isGogCanaryCard({ cardName: "P1 - GOG Auth: re-auth needed" }), true);
  assert.equal(isGogCanaryCard({ cardName: "P2 - GOG Auth: token expired" }), true);
  assert.equal(isGogCanaryCard({ cardName: "P2 - Email: hello" }), false);
  assert.equal(isGogCanaryCard({ text: "P1 - GOG Auth: disabled_client" }), true);
});
