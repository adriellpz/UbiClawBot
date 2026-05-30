import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnvFile } from "./load_env.mjs";

test("loadEnvFile fills missing Trello poll credentials without overriding existing env", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-env-"));
  const envFile = path.join(dir, "gateway.env");
  fs.writeFileSync(envFile, "TRELLO_API_KEY=poll-key\nTRELLO_API_TOKEN=poll-token\nTRELLO_BOARD_ID=board123\n");

  const env = { TRELLO_BOARD_ID: "from-main" };
  assert.equal(loadEnvFile(envFile, env), true);
  assert.equal(env.TRELLO_API_KEY, "poll-key");
  assert.equal(env.TRELLO_API_TOKEN, "poll-token");
  assert.equal(env.TRELLO_BOARD_ID, "from-main");
});
