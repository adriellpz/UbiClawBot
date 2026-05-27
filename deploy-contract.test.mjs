import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  DEPLOY_WORKFLOW_PATH,
  GITHUB_PR_BRIDGE_HEALTH_URL,
  getDeploySshScript,
} from "./deploy-contract.helpers.mjs";

test("deploy ssh script waits for github-pr-bridge /healthz after compose up", () => {
  const script = getDeploySshScript();

  assert(script.includes(GITHUB_PR_BRIDGE_HEALTH_URL));
  assert.match(
    script,
    /for attempt in \$\(seq 1 30\)/u,
    `${DEPLOY_WORKFLOW_PATH}: deploy should retry github-pr-bridge health instead of one-shot curl`,
  );

  const composeUpIndex = script.indexOf("docker compose up");
  const retryIndex = script.indexOf("for attempt in $(seq 1 30)");
  assert(
    composeUpIndex >= 0 && retryIndex > composeUpIndex,
    `${DEPLOY_WORKFLOW_PATH}: health retry should run after docker compose up`,
  );
});

test("deploy ssh script passes bash -n", () => {
  const script = getDeploySshScript();
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr.trim());
});
