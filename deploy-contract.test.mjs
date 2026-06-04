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

test("deploy ssh script loads BOARD_BASICAUTH_HASH before caddy validate", () => {
  const script = getDeploySshScript();
  assert(script.includes("read_deploy_env_var BOARD_BASICAUTH_HASH"));
  assert(script.includes("export BOARD_BASICAUTH_HASH"));
  assert(script.includes('caddy validate --config "$config"'));
  assert(!script.includes("sudo") || !script.match(/sudo[^\n]*caddy validate/));
});

test("deploy ssh script uses passwordless sudo for caddy install/reload", () => {
  const script = getDeploySshScript();
  assert(script.includes("sudo_deploy()"));
  assert(script.includes("sudo -n"));
  assert(script.includes("sudo_deploy install"));
  assert(script.includes("sudo_deploy systemctl reload caddy"));
});

test("deploy ssh script syncs /etc/caddy/environment before caddy install", () => {
  const script = getDeploySshScript();
  assert(script.includes("caddy_sync_env_file"));
  assert(script.includes("sudo_deploy tee /etc/caddy/environment"));
  // env file write must precede the install step
  const syncIdx = script.indexOf("caddy_sync_env_file");
  const installIdx = script.indexOf("sudo_deploy install");
  assert(syncIdx < installIdx, "caddy_sync_env_file must come before sudo_deploy install");
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

test("task-board compose mounts app code read-only and vault outside /app", () => {
  const compose = getComposeDropletYaml();
  const taskBoard = compose?.services?.["task-board"];
  assert.ok(taskBoard, `${COMPOSE_DROPLET_PATH}: task-board service not found`);
  const volumes = taskBoard?.volumes ?? [];
  const hasAppMount = volumes.some(
    (v) => typeof v === "string" && v === "./task-board:/app:ro",
  );
  const hasVaultMount = volumes.some(
    (v) => typeof v === "string" && v.endsWith(":/vault"),
  );
  assert.ok(
    hasAppMount,
    `${COMPOSE_DROPLET_PATH}: task-board must mount ./task-board:/app:ro so manifest.json, sw.js, and icon.svg are available at startup`,
  );
  assert.ok(
    hasVaultMount,
    `${COMPOSE_DROPLET_PATH}: task-board vault must mount at /vault (not /app/vault) because /app is read-only`,
  );
  assert.equal(
    taskBoard?.environment?.TASKS_DIR,
    "/vault/tasks",
    `${COMPOSE_DROPLET_PATH}: TASKS_DIR must point at the vault mount`,
  );
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

test("config/live/openclaw.json template does not set hooks.gmail.model", () => {
  const config = JSON.parse(readFileSync(new URL("config/live/openclaw.json", import.meta.url), "utf8"));
  assert.equal(
    config.hooks?.gmail?.model,
    undefined,
    "hooks.gmail.model must not be set in the live config template — it triggers the event-loop-blocking gmail-model sidecar",
  );
});

test("deploy ssh script installs vault-reindex cron via sudo_deploy install (not raw cp+chown)", () => {
  const script = getDeploySshScript();
  assert.match(
    script,
    /sudo_deploy install.*openclaw-vault-reindex.*\/etc\/cron\.d\/openclaw-vault-reindex/,
    "vault-reindex cron must be installed via sudo_deploy install, not raw cp/chown — deploy user lacks direct /etc/cron.d write access",
  );
  assert.ok(
    !script.match(/cp .*openclaw-vault-reindex[^\n]*\/etc\/cron\.d/),
    "vault-reindex cron must not be installed with raw cp — use sudo_deploy install",
  );
});

test("generated vault root index links all non-hidden dirs including raw-input", async () => {
  const { generateVaultIndexes } = await import("./runtime/cheryl/wiki-maintainer/lib/vault-index-generator.mjs");
  const { mkdtemp, mkdir, writeFile, readFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");

  const dir = await mkdtemp(path.join(os.tmpdir(), "vault-root-index-"));
  await mkdir(path.join(dir, "wiki"), { recursive: true });
  await mkdir(path.join(dir, "raw-input"), { recursive: true });
  await mkdir(path.join(dir, "marcos"), { recursive: true });
  await writeFile(path.join(dir, "marcos", "AGENTS.md"), "# AGENTS\n", "utf8");
  await writeFile(path.join(dir, "raw-input", "inbox.md"), "# inbox\n", "utf8");

  const vaultName = path.basename(dir);
  await generateVaultIndexes(dir, { generatedAt: "2026-01-01T00:00:00Z" });

  const rootIndex = await readFile(path.join(dir, `${vaultName}-index.md`), "utf8");
  assert.ok(rootIndex.includes("[[raw-input/raw-input-index]]"), "root index must link to raw-input (index is generated for it)");
  assert.ok(rootIndex.includes("[[marcos/marcos-index]]"), "root index must link to marcos");
  assert.ok(rootIndex.includes("[[wiki/wiki-index]]"), "root index must link to wiki");
  assert.ok(!rootIndex.includes("[[.obsidian/"), "root index must not link to hidden dirs");
});

test("deploy ssh script passes bash -n", () => {
  const script = getDeploySshScript();
  const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr.trim());
});
