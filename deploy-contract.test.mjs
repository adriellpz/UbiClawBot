import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertDeployWorkflowMatchesManifest,
  DEPLOY_WORKFLOW_PATH,
  getDeploySshScript,
  getDeploySshWrapperScript,
  getDeployWorkflowYaml,
  GITHUB_PR_BRIDGE_HEALTH_URL,
  loadDeployManifest,
} from "./deploy-contract.helpers.mjs";

test("deploy manifest loads and lists production copy bundles", () => {
  const manifest = loadDeployManifest();
  assert.equal(manifest.version, 1);
  assert.ok(manifest.copyBundles.some((bundle) => bundle.id === "scripts-manual"));
  assert.ok(manifest.smokeChecks.requiredFiles.includes("scripts/manual/backfill_routine_card_due.mjs"));
});

test("deploy workflow matches deploy/manifest.json", () => {
  const issues = assertDeployWorkflowMatchesManifest();
  assert.deepEqual(issues, [], `deploy workflow drift:\n${issues.join("\n")}`);
});

test("deploy job targets GitHub production environment", () => {
  const workflow = getDeployWorkflowYaml();
  assert.equal(workflow.jobs?.deploy?.environment, "production");
});

test("deploy ssh wrapper invokes remote deploy script", () => {
  const wrapper = getDeploySshWrapperScript();
  assert.match(wrapper, /deploy-droplet-remote\.sh/);
});

test("deploy ssh script smoke-checks HTTP endpoints after compose up", () => {
  const script = getDeploySshScript();

  assert(script.includes(GITHUB_PR_BRIDGE_HEALTH_URL));
  assert(script.includes('smoke_http "http://127.0.0.1:18792/healthz"'));
  assert(script.includes('smoke_http "http://127.0.0.1:18990/health"'));

  const composeUpIndex = script.indexOf("docker compose up");
  const gatewaySmokeIndex = script.indexOf('smoke_http "http://127.0.0.1:18792/healthz"');
  assert(
    composeUpIndex >= 0 && gatewaySmokeIndex > composeUpIndex,
    `${DEPLOY_WORKFLOW_PATH}: HTTP smoke checks should run after docker compose up`,
  );
});

test("deploy ssh script passes bash -n", () => {
  const script = getDeploySshScript();
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr.trim());
});
