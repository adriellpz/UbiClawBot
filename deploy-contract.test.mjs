import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  assertDeployWorkflowMatchesManifest,
  COMPOSE_DROPLET_PATH,
  DEPLOY_WORKFLOW_PATH,
  deployWorkflowHasPushTrigger,
  getComposeDropletYaml,
  getDeploySshScript,
  getDeploySshWrapperScript,
  getDeployWorkflowYaml,
  getQmdIndexYaml,
  GITHUB_PR_BRIDGE_HEALTH_URL,
  GMAIL_HOOK_BRIDGE_HEALTH_URL,
  GOG_CANARY_BRIDGE_HEALTH_URL,
  loadDeployManifest,
  QMD_INDEX_PATH,
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

test("deploy manifest pathFilters apply only when workflow has push trigger", () => {
  assert.equal(deployWorkflowHasPushTrigger(), false);
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
  assert(script.includes(GMAIL_HOOK_BRIDGE_HEALTH_URL));
  assert(script.includes(GOG_CANARY_BRIDGE_HEALTH_URL));
  assert(script.includes('smoke_http "http://127.0.0.1:18792/healthz"'));
  assert(script.includes('smoke_http "http://127.0.0.1:18990/health"'));

  const composeUpIndex = script.indexOf("docker compose up");
  const gatewaySmokeIndex = script.indexOf('smoke_http "http://127.0.0.1:18792/healthz"');
  assert(
    composeUpIndex >= 0 && gatewaySmokeIndex > composeUpIndex,
    `${DEPLOY_WORKFLOW_PATH}: HTTP smoke checks should run after docker compose up`,
  );
});

test("openclaw-gateway compose service bind-mounts qmd cache at /home/node/.cache/qmd", () => {
  const compose = getComposeDropletYaml();
  const gateway = compose?.services?.["openclaw-gateway"];
  assert.ok(gateway, `${COMPOSE_DROPLET_PATH}: openclaw-gateway service not found`);
  const volumes = gateway?.volumes ?? [];
  const cacheMount = volumes.find((v) => {
    if (typeof v === "string") return v.endsWith(":/home/node/.cache/qmd");
    return v?.target === "/home/node/.cache/qmd";
  });
  assert.ok(cacheMount, `${COMPOSE_DROPLET_PATH}: openclaw-gateway missing bind-mount for /home/node/.cache/qmd`);
});

test("deploy/host-config/qmd/index.yml defines wiki and openclaw-docs collections at correct paths", () => {
  const config = getQmdIndexYaml();
  const collections = config?.collections ?? {};
  assert.ok("wiki" in collections, `${QMD_INDEX_PATH}: missing wiki collection`);
  assert.ok("openclaw-docs" in collections, `${QMD_INDEX_PATH}: missing openclaw-docs collection`);
  assert.ok(
    !String(collections.wiki?.path ?? "").includes("openclaw-docs"),
    `${QMD_INDEX_PATH}: wiki collection path must not include openclaw-docs/`,
  );
  assert.ok(
    String(collections["openclaw-docs"]?.path ?? "").includes("openclaw-docs"),
    `${QMD_INDEX_PATH}: openclaw-docs collection path must reference openclaw-docs/`,
  );
});

test("deploy manifest installs qmd index.yml via copy bundle", () => {
  const issues = assertDeployWorkflowMatchesManifest();
  const manifest = loadDeployManifest();
  const qmdBundle = manifest.copyBundles.find((b) => b.id === "qmd-host-config");
  assert.ok(qmdBundle, "deploy/manifest.json: missing qmd-host-config copy bundle");
  assert.ok(
    qmdBundle.scpSource.includes("host-config/qmd"),
    "qmd-host-config bundle scpSource must reference deploy/host-config/qmd",
  );
  assert.ok(
    qmdBundle.installMarkers.some((m) => m.includes("index.yml")),
    "qmd-host-config bundle must have an installMarker referencing index.yml",
  );
  assert.deepEqual(issues, [], `deploy workflow drift:\n${issues.join("\n")}`);
});

test("qmd-reindex.sh uses --max-docs-per-batch to prevent session expiry", () => {
  const script = readFileSync(
    new URL("deploy/host-cron/qmd-reindex.sh", import.meta.url),
    "utf8",
  );
  assert.match(script, /--max-docs-per-batch/, "qmd-reindex.sh: qmd embed must include --max-docs-per-batch flag");
});

test("deploy ssh script passes bash -n", () => {
  const script = getDeploySshScript();
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr.trim());
});
