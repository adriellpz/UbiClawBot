#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseDocument } from "yaml";

const repoRoot = process.cwd();
const failures = [];
const skipped = [];
const passed = [];

function fail(message) {
  failures.push(message);
}

function pass(message) {
  passed.push(message);
}

function skip(message) {
  skipped.push(message);
}

function readText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function listFiles(dir, predicate) {
  const absolute = path.join(repoRoot, dir);
  if (!existsSync(absolute)) return [];
  const result = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current);
    } catch (error) {
      skip(`${path.relative(repoRoot, current)}: skipped unreadable directory: ${error.code ?? error.message}`);
      return;
    }

    for (const entry of entries) {
      const full = path.join(current, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch (error) {
        skip(`${path.relative(repoRoot, full)}: skipped unreadable path: ${error.code ?? error.message}`);
        continue;
      }

      if (stat.isDirectory()) walk(full);
      else if (predicate(full)) result.push(path.relative(repoRoot, full));
    }
  };
  walk(absolute);
  return result.sort();
}

function parseYamlFile(relativePath) {
  const source = readText(relativePath);
  const doc = parseDocument(source, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length > 0) {
    fail(`${relativePath}: YAML parse failed: ${doc.errors.map((e) => e.message).join("; ")}`);
    return null;
  }
  if (doc.warnings.length > 0) {
    fail(`${relativePath}: YAML warnings: ${doc.warnings.map((e) => e.message).join("; ")}`);
    return null;
  }
  pass(`${relativePath}: YAML parsed`);
  return doc.toJSON();
}

function validateJsonFiles() {
  const jsonFiles = [
    "package.json",
    "package-lock.json",
    "config/openclaw.example.json",
    "config/live/openclaw.json",
    "deploy/manifest.json",
  ];

  for (const file of jsonFiles) {
    assert(existsSync(path.join(repoRoot, file)), `${file}: expected deploy-contract JSON file to exist`);
    try {
      JSON.parse(readText(file));
      pass(`${file}: JSON parsed`);
    } catch (error) {
      fail(`${file}: JSON parse failed: ${error.message}`);
    }
  }
}

function validateYamlFiles() {
  const yamlFiles = [
    ...listFiles(".github", (full) => /\.(ya?ml)$/u.test(full)),
    ...listFiles("workspace", (full) => /\.(ya?ml)$/u.test(full)),
  ].sort();

  assert(yamlFiles.length > 0, "Expected at least one YAML file to validate");
  return Object.fromEntries(yamlFiles.map((file) => [file, parseYamlFile(file)]));
}

function validateDeployWorkflow(workflows) {
  const workflowPath = ".github/workflows/deploy-droplet.yml";
  const workflow = workflows[workflowPath];
  if (!workflow) return;

  assert(workflow.name === "Deploy to Droplet", `${workflowPath}: expected workflow name to stay explicit`);
  assert(workflow.on?.workflow_dispatch !== undefined, `${workflowPath}: expected manual workflow_dispatch trigger`);
  assert(Array.isArray(workflow.on?.schedule) && workflow.on.schedule.length > 0, `${workflowPath}: expected nightly schedule trigger`);
  assert(
    workflow.on?.push === undefined,
    `${workflowPath}: merge deploy is paused — use workflow_dispatch until push trigger is restored`,
  );
  assert(!workflow.on?.pull_request, `${workflowPath}: deploy workflow must not run on pull_request`);
  assert(workflow.concurrency?.group === "deploy-droplet-main", `${workflowPath}: expected deploy concurrency group`);

  const deploy = workflow.jobs?.deploy;
  assert(deploy?.["runs-on"] === "ubuntu-latest", `${workflowPath}: deploy job should run on ubuntu-latest`);

  const steps = deploy?.steps ?? [];
  const uses = steps.map((step) => step.uses).filter(Boolean);
  for (const action of ["actions/checkout@v4", "appleboy/scp-action@v0.1.7", "appleboy/ssh-action@v1.0.3"]) {
    assert(uses.includes(action), `${workflowPath}: expected pinned action ${action}`);
  }

  const sshStep = steps.find((step) => step.uses === "appleboy/ssh-action@v1.0.3");
  const script = sshStep?.with?.script;
  assert(sshStep?.with?.script_stop === true, `${workflowPath}: ssh deploy step should set script_stop: true`);
  assert(typeof script === "string" && script.includes("set -eu"), `${workflowPath}: ssh deploy script should use set -eu`);
  assert(typeof script === "string" && script.includes("trello-bridge"), `${workflowPath}: deploy script should restart trello-bridge with the other services`);
  assert(typeof script === "string" && script.includes("trello-pipeline"), `${workflowPath}: deploy script should copy trello-pipeline`);
  assert(typeof script === "string" && script.includes("trello-routines"), `${workflowPath}: deploy script should copy and restart trello-routines`);
  assert(typeof script === "string" && script.includes("trello-gateway"), `${workflowPath}: deploy script should copy and restart trello-gateway`);
  assert(typeof script === "string" && script.includes("trello-queue-worker"), `${workflowPath}: deploy script should restart trello-queue-worker`);
  assert(typeof script === "string" && script.includes("http://127.0.0.1:${GITHUB_PR_BRIDGE_PORT:-19091}/healthz"), `${workflowPath}: deploy script should verify github-pr-bridge local health after restart`);
  assert(typeof script === "string" && script.includes("http://127.0.0.1:${GMAIL_HOOK_BRIDGE_PORT:-19092}/healthz"), `${workflowPath}: deploy script should verify gmail-hook-bridge local health after restart`);
  assert(typeof script === "string" && script.includes("http://127.0.0.1:${GOG_CANARY_BRIDGE_PORT:-19093}/healthz"), `${workflowPath}: deploy script should verify gog-canary-bridge local health after restart`);

  if (typeof script === "string") {
    assert(script.includes("trello_card_contract.mjs"), `${workflowPath}: deploy script should copy trello_card_contract.mjs with the gateway artifacts`);
    const composeUpLine = script.split("\n").find((line) => /docker\s+compose\s+up\b/u.test(line));
    assert(composeUpLine?.includes("trello-bridge"), `${workflowPath}: docker compose up should restart trello-bridge`);
    assert(composeUpLine?.includes("github-pr-bridge"), `${workflowPath}: docker compose up should restart github-pr-bridge`);
    assert(composeUpLine?.includes("gmail-hook-bridge"), `${workflowPath}: docker compose up should restart gmail-hook-bridge`);
    assert(composeUpLine?.includes("gog-canary-bridge"), `${workflowPath}: docker compose up should restart gog-canary-bridge`);
    assert(composeUpLine?.includes("trello-routines"), `${workflowPath}: docker compose up should restart trello-routines`);
    assert(composeUpLine?.includes("trello-gateway"), `${workflowPath}: docker compose up should restart trello-gateway`);
    assert(composeUpLine?.includes("trello-queue-worker"), `${workflowPath}: docker compose up should restart trello-queue-worker`);
    assert(!script.includes("trello-gateway/.env") || script.includes(".env.example"), `${workflowPath}: deploy script must not overwrite trello-gateway/.env`);

    const result = spawnSync("bash", ["-n"], { input: script, encoding: "utf8" });
    assert(result.status === 0, `${workflowPath}: embedded ssh script failed bash -n: ${result.stderr.trim()}`);
    if (result.status === 0) pass(`${workflowPath}: embedded ssh script passed bash -n`);
  }
}

function validateCompose(workflows) {
  const composePath = "workspace/docker-compose.droplet.yml";
  const compose = workflows[composePath];
  if (!compose) return;

  const services = compose.services ?? {};
  for (const service of ["openclaw-gateway", "openclaw-cli", "trello-bridge", "github-pr-bridge", "gmail-hook-bridge", "gog-canary-bridge", "trello-gateway", "trello-queue-worker", "trello-routines"]) {
    assert(services[service], `${composePath}: expected service ${service}`);
  }

  const gateway = services["openclaw-gateway"] ?? {};
  assert(gateway.build?.dockerfile === "Dockerfile.gog", `${composePath}: gateway should build Dockerfile.gog`);
  assert(gateway.restart === "unless-stopped", `${composePath}: gateway should restart unless stopped`);
  assert(Array.isArray(gateway.ports), `${composePath}: gateway ports should be declared`);
  for (const port of gateway.ports ?? []) {
    assert(String(port).startsWith("127.0.0.1:"), `${composePath}: published port must bind to 127.0.0.1, got ${port}`);
  }
  assert(Array.isArray(gateway.volumes) && gateway.volumes.some((volume) => String(volume).includes(":/home/node/.openclaw")), `${composePath}: gateway should mount OpenClaw config volume`);
  assert(gateway.volumes.some((volume) => String(volume).includes(":/home/node/.openclaw/agent-vault")), `${composePath}: gateway should mount agent workspace vault`);
  assert(gateway.volumes.some((volume) => String(volume).includes(":/home/node/.openclaw/agent-runtime")), `${composePath}: gateway should mount agent runtime (non-synced scripts)`);
  assert(
    !gateway.volumes.some((volume) => String(volume).includes(":/home/node/.openclaw/workspace")),
    `${composePath}: gateway must not mount legacy workspace after vault phase 7`,
  );
  assert(gateway.healthcheck?.test, `${composePath}: gateway should keep a healthcheck`);
  const gatewayPorts = JSON.stringify(gateway.ports ?? []);
  assert(gatewayPorts.includes("19092"), `${composePath}: gateway should publish gmail-hook-bridge port 19092`);
  assert(gatewayPorts.includes("19093"), `${composePath}: gateway should publish gog-canary-bridge port 19093`);

  const cli = services["openclaw-cli"] ?? {};
  assert(cli.network_mode === "service:openclaw-gateway", `${composePath}: cli should share gateway network namespace`);
  assert(Array.isArray(cli.cap_drop) && cli.cap_drop.includes("NET_RAW") && cli.cap_drop.includes("NET_ADMIN"), `${composePath}: cli should drop network admin capabilities`);
  assert(Array.isArray(cli.security_opt) && cli.security_opt.includes("no-new-privileges:true"), `${composePath}: cli should set no-new-privileges`);

  const trelloBridge = services["trello-bridge"] ?? {};
  assert(trelloBridge.network_mode === "service:openclaw-gateway", `${composePath}: trello-bridge should share gateway network namespace`);
  assert(trelloBridge.working_dir === "/opt/trello-pipeline", `${composePath}: trello-bridge should run from the repo-owned runtime path`);
  assert(Array.isArray(trelloBridge.volumes) && trelloBridge.volumes.some((volume) => String(volume).includes("./trello-pipeline:/opt/trello-pipeline:ro")), `${composePath}: trello-bridge should mount the tracked pipeline folder read-only`);
  assert(trelloBridge.healthcheck?.test, `${composePath}: trello-bridge should keep a healthcheck`);
  const trelloBridgeEnv = trelloBridge.environment ?? {};
  assert(trelloBridgeEnv.TRELLO_GATEWAY_URL !== undefined, `${composePath}: trello-bridge should use TRELLO_GATEWAY_URL`);
  assert(trelloBridgeEnv.TRELLO_GATEWAY_KEY !== undefined, `${composePath}: trello-bridge should use TRELLO_GATEWAY_KEY`);
  assert(trelloBridgeEnv.TRELLO_PIPELINE_STATE_DIR !== undefined, `${composePath}: trello-bridge should set TRELLO_PIPELINE_STATE_DIR`);
  assert(
    trelloBridgeEnv.TRELLO_PIPELINE_ENV_FILE === "/opt/trello-gateway/.env",
    `${composePath}: trello-bridge should load poll creds from trello-gateway/.env`,
  );
  assert(
    (trelloBridge.volumes ?? []).some((volume) => String(volume).includes("./trello-gateway/.env:/opt/trello-gateway/.env:ro")),
    `${composePath}: trello-bridge should mount trello-gateway/.env read-only for poll fallback`,
  );

  const githubPrBridge = services["github-pr-bridge"] ?? {};
  assert(githubPrBridge.network_mode === "service:openclaw-gateway", `${composePath}: github-pr-bridge should share gateway network namespace`);
  assert(githubPrBridge.working_dir === "/opt/github-pr-bridge", `${composePath}: github-pr-bridge working_dir should stay explicit`);
  assert(githubPrBridge.command?.includes("server.mjs"), `${composePath}: github-pr-bridge should run server.mjs`);
  assert(githubPrBridge.healthcheck?.test, `${composePath}: github-pr-bridge should keep a healthcheck`);
  const githubBridgeHealth = JSON.stringify(githubPrBridge.healthcheck?.test ?? []);
  assert(githubBridgeHealth.includes("127.0.0.1:19091/healthz"), `${composePath}: github-pr-bridge healthcheck should probe port 19091 /healthz`);
  assert(!githubBridgeHealth.includes("127.0.0.1:18789"), `${composePath}: github-pr-bridge healthcheck must not probe openclaw-gateway port 18789`);
  const githubBridgeEnv = githubPrBridge.environment ?? {};
  assert(githubBridgeEnv.TRELLO_GATEWAY_URL !== undefined, `${composePath}: github-pr-bridge should use TRELLO_GATEWAY_URL`);
  assert(githubBridgeEnv.TRELLO_GATEWAY_KEY !== undefined, `${composePath}: github-pr-bridge should use TRELLO_GATEWAY_KEY`);
  assert(githubBridgeEnv.TRELLO_GATEWAY_AGENT_ID !== undefined, `${composePath}: github-pr-bridge should set TRELLO_GATEWAY_AGENT_ID`);
  assert(
    String(githubBridgeEnv.TRELLO_GATEWAY_AGENT_ID).includes("system"),
    `${composePath}: github-pr-bridge TRELLO_GATEWAY_AGENT_ID default should be system`,
  );
  assert(
    String(githubBridgeEnv.OPENCLAW_HOOK_AGENT_ID).includes("marcos"),
    `${composePath}: github-pr-bridge OPENCLAW_HOOK_AGENT_ID default should be marcos`,
  );
  assert(githubBridgeEnv.TRELLO_API_KEY === undefined, `${composePath}: github-pr-bridge should not receive raw TRELLO_API_KEY`);
  assert(githubBridgeEnv.TRELLO_API_TOKEN === undefined, `${composePath}: github-pr-bridge should not receive raw TRELLO_API_TOKEN`);
  assert(githubPrBridge.depends_on?.["trello-gateway"]?.condition === "service_healthy", `${composePath}: github-pr-bridge should wait for trello-gateway health`);

  const gmailHookBridge = services["gmail-hook-bridge"] ?? {};
  assert(gmailHookBridge.network_mode === "service:openclaw-gateway", `${composePath}: gmail-hook-bridge should share gateway network namespace`);
  assert(gmailHookBridge.working_dir === "/opt/gmail-hook-bridge", `${composePath}: gmail-hook-bridge working_dir should stay explicit`);
  assert(gmailHookBridge.command?.includes("server.mjs"), `${composePath}: gmail-hook-bridge should run server.mjs`);
  assert(gmailHookBridge.healthcheck?.test, `${composePath}: gmail-hook-bridge should keep a healthcheck`);
  const gmailBridgeHealth = JSON.stringify(gmailHookBridge.healthcheck?.test ?? []);
  assert(gmailBridgeHealth.includes("127.0.0.1:19092/healthz"), `${composePath}: gmail-hook-bridge healthcheck should probe port 19092 /healthz`);
  const gmailBridgeEnv = gmailHookBridge.environment ?? {};
  assert(gmailBridgeEnv.TRELLO_GATEWAY_URL !== undefined, `${composePath}: gmail-hook-bridge should use TRELLO_GATEWAY_URL`);
  assert(gmailBridgeEnv.OPENCLAW_HOOK_AGENT_ID !== undefined, `${composePath}: gmail-hook-bridge should set OPENCLAW_HOOK_AGENT_ID`);
  assert(gmailHookBridge.depends_on?.["trello-gateway"]?.condition === "service_healthy", `${composePath}: gmail-hook-bridge should wait for trello-gateway health`);

  const gogCanaryBridge = services["gog-canary-bridge"] ?? {};
  assert(gogCanaryBridge.network_mode === "service:openclaw-gateway", `${composePath}: gog-canary-bridge should share gateway network namespace`);
  assert(gogCanaryBridge.working_dir === "/opt/gog-canary-bridge", `${composePath}: gog-canary-bridge working_dir should stay explicit`);
  assert(gogCanaryBridge.command?.includes("server.mjs"), `${composePath}: gog-canary-bridge should run server.mjs`);
  assert(gogCanaryBridge.healthcheck?.test, `${composePath}: gog-canary-bridge should keep a healthcheck`);
  const gogCanaryHealth = JSON.stringify(gogCanaryBridge.healthcheck?.test ?? []);
  assert(gogCanaryHealth.includes("127.0.0.1:19093/healthz"), `${composePath}: gog-canary-bridge healthcheck should probe port 19093 /healthz`);
  const gogCanaryEnv = gogCanaryBridge.environment ?? {};
  assert(gogCanaryEnv.TRELLO_GATEWAY_URL !== undefined, `${composePath}: gog-canary-bridge should use TRELLO_GATEWAY_URL`);
  assert(gogCanaryEnv.GOG_KEYRING_PASSWORD !== undefined, `${composePath}: gog-canary-bridge should receive GOG_KEYRING_PASSWORD`);
  assert(gogCanaryEnv.OPENCLAW_HOOK_AGENT_ID !== undefined, `${composePath}: gog-canary-bridge should set OPENCLAW_HOOK_AGENT_ID`);
  assert(gogCanaryBridge.depends_on?.["trello-gateway"]?.condition === "service_healthy", `${composePath}: gog-canary-bridge should wait for trello-gateway health`);

  const trelloGateway = services["trello-gateway"] ?? {};
  assert(trelloGateway.build?.context === "./trello-gateway", `${composePath}: trello-gateway should build from ./trello-gateway`);
  assert(trelloGateway.image === "trello-gateway:local", `${composePath}: trello-gateway image tag should stay explicit`);
  assert(trelloGateway.healthcheck?.test, `${composePath}: trello-gateway should keep a healthcheck`);
  assert(String(trelloGateway.ports?.[0] ?? "").startsWith("127.0.0.1:18792"), `${composePath}: trello-gateway should bind 127.0.0.1:18792 on the host`);
  assert((trelloGateway.environment ?? {}).TRELLO_PIPELINE_STATE_DIR !== undefined, `${composePath}: trello-gateway should share the repo-owned pipeline state path`);
  assert(Array.isArray(trelloGateway.volumes) && trelloGateway.volumes.some((volume) => String(volume).includes("./trello-gateway/trello_card_contract.mjs:/app/trello_card_contract.mjs:ro")), `${composePath}: trello-gateway should mount trello_card_contract.mjs`);

  const trelloQueueWorker = services["trello-queue-worker"] ?? {};
  assert(trelloQueueWorker.working_dir === "/opt/trello-pipeline", `${composePath}: trello-queue-worker should run from the repo-owned runtime path`);
  assert(trelloQueueWorker.command?.includes("start_queue_worker.mjs"), `${composePath}: trello-queue-worker should run start_queue_worker.mjs`);
  assert(trelloQueueWorker.healthcheck?.test, `${composePath}: trello-queue-worker should keep a healthcheck`);
  assert(Array.isArray(trelloQueueWorker.volumes) && trelloQueueWorker.volumes.some((volume) => String(volume).includes("./trello-pipeline:/opt/trello-pipeline:ro")), `${composePath}: trello-queue-worker should mount the tracked pipeline folder read-only`);
  const workerHealth = JSON.stringify(trelloQueueWorker.healthcheck?.test ?? []);
  assert(!workerHealth.includes("18789"), `${composePath}: trello-queue-worker healthcheck must not probe openclaw-gateway port 18789`);
  assert(workerHealth.includes("queue_worker.pid"), `${composePath}: trello-queue-worker healthcheck should verify worker pid files`);
  assert(workerHealth.includes("$${s}/$${f}"), `${composePath}: trello-queue-worker healthcheck must escape shell template dollars for Compose`);
  assert(workerHealth.includes("TRELLO_PIPELINE_STATE_DIR"), `${composePath}: trello-queue-worker healthcheck should use the repo-owned state env`);
  assert(trelloQueueWorker.depends_on?.["trello-gateway"]?.condition === "service_healthy", `${composePath}: trello-queue-worker should wait for trello-gateway health`);

  const trelloRoutines = services["trello-routines"] ?? {};
  assert(trelloRoutines.network_mode === "service:openclaw-gateway", `${composePath}: trello-routines should share gateway network namespace`);
  assert(trelloRoutines.working_dir === "/opt/trello-routines", `${composePath}: trello-routines should run from the repo-owned runtime path`);
  assert(JSON.stringify(trelloRoutines.command ?? []).includes("start_routines_loop.sh"), `${composePath}: trello-routines should run the loop script`);
  assert(Array.isArray(trelloRoutines.volumes) && trelloRoutines.volumes.some((volume) => String(volume).includes("./trello-routines:/opt/trello-routines:ro")), `${composePath}: trello-routines should mount the tracked repo folder read-only`);
  const routinesEnv = trelloRoutines.environment ?? {};
  assert(routinesEnv.TRELLO_GATEWAY_URL !== undefined, `${composePath}: trello-routines should use TRELLO_GATEWAY_URL`);
  assert(routinesEnv.TRELLO_GATEWAY_KEY !== undefined, `${composePath}: trello-routines should use TRELLO_GATEWAY_KEY`);
  assert(routinesEnv.TRELLO_API_KEY === undefined, `${composePath}: trello-routines should not receive raw TRELLO_API_KEY`);
  assert(routinesEnv.TRELLO_API_TOKEN === undefined, `${composePath}: trello-routines should not receive raw TRELLO_API_TOKEN`);
  assert(trelloRoutines.depends_on?.["trello-gateway"]?.condition === "service_healthy", `${composePath}: trello-routines should wait for trello-gateway health`);
  assert(trelloRoutines.healthcheck?.test, `${composePath}: trello-routines should keep a healthcheck`);
}

function validateTrelloGatewayDir() {
  const dir = "trello-gateway";
  for (const file of ["Dockerfile", "deploy.sh", "trello_card_contract.mjs", "trello_gateway.mjs", "trello_transition_matrix.csv", ".env.example"]) {
    assert(existsSync(path.join(repoRoot, dir, file)), `${dir}/${file}: expected tracked gateway file`);
  }

  const gitignore = readText(".gitignore");
  assert(gitignore.includes("trello-gateway/.env"), ".gitignore: trello-gateway/.env must stay ignored");

  const deployScript = readText(`${dir}/deploy.sh`);
  assert(deployScript.includes("set -eu"), "trello-gateway/deploy.sh: should use set -eu");
  assert(!deployScript.includes(".env.example") || deployScript.includes("copy from trello-gateway/.env.example"), "trello-gateway/deploy.sh: should not overwrite live .env");

  const gatewayScript = readText(`${dir}/trello_gateway.mjs`);
  assert(gatewayScript.includes("./trello_card_contract.mjs"), "trello-gateway/trello_gateway.mjs: should import the local trello_card_contract.mjs");
  assert(!gatewayScript.includes("workspace-marcos/trello-refactor/trello_transition_matrix.csv"), "trello-gateway/trello_gateway.mjs: should not default to a MarcosAgent workspace path");
  assert(gatewayScript.includes("new URL('./trello_transition_matrix.csv', import.meta.url)"), "trello-gateway/trello_gateway.mjs: should resolve the local transition matrix by default");
  assert(!gatewayScript.includes("/home/node/.openclaw/workspace/trello_bridge/state"), "trello-gateway/trello_gateway.mjs: should not use the old workspace-backed pipeline state path");
  pass("trello-gateway/: static directory checks completed");
}

function validateTrelloRoutinesDir() {
  const dir = "trello-routines";
  for (const file of [
    "ensure_routines.mjs",
    "ensure_routines_logic.mjs",
    "ensure_routines.test.mjs",
    "ensure_routines_logic.test.mjs",
    "routine_manifest.json",
    "routine_manifest.test.mjs",
    "routine_calendar_lookup.mjs",
    "trello_card_calendar_desc.mjs",
    "trello_gateway_module.mjs",
    "trello_open_card_contract.mjs",
    "start_routines_loop.sh",
  ]) {
    assert(existsSync(path.join(repoRoot, dir, file)), `${dir}/${file}: expected tracked routines file`);
  }

  const loopScript = readText(`${dir}/start_routines_loop.sh`);
  assert(loopScript.includes("ensure_routines.mjs"), "trello-routines/start_routines_loop.sh: should run ensure_routines.mjs");
  assert(loopScript.includes("last_run.json"), "trello-routines/start_routines_loop.sh: should write a heartbeat file");
  pass("trello-routines/: static directory checks completed");
}

function validateTrelloPipelineDir() {
  const dir = "trello-pipeline";
  for (const file of [
    "server.mjs",
    "server.test.mjs",
    "trello_queue_worker.mjs",
    "queue_worker.test.mjs",
    "smoke.test.mjs",
    "start_queue_worker.mjs",
    "handle_reschedule.mjs",
    "handle_reschedule_logic.mjs",
    "handle_reschedule_logic.test.mjs",
    "trello_done_adjust_calendar.mjs",
    "trello_missed_adjust_calendar.mjs",
    "calendar_lookup.mjs",
    "trello_card_calendar_desc.mjs",
  ]) {
    assert(existsSync(path.join(repoRoot, dir, file)), `${dir}/${file}: expected tracked pipeline file`);
  }
  pass("trello-pipeline/: static directory checks completed");
}

function validateCaddyfile() {
  const caddyPath = "Caddyfile.droplet";
  const source = readText(caddyPath);
  let depth = 0;
  for (const char of source) {
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth < 0) fail(`${caddyPath}: closing brace appears before an opening brace`);
  }
  assert(depth === 0, `${caddyPath}: braces should be balanced`);
  for (const expected of ["ai.sonofwolf.org", "handle_path /gmail-pubsub*", "handle /github-pr*", "reverse_proxy 127.0.0.1:8788", "reverse_proxy 127.0.0.1:18990", "reverse_proxy 127.0.0.1:19091", "reverse_proxy 127.0.0.1:18789", "header Upgrade websocket", "flush_interval -1"]) {
    assert(source.includes(expected), `${caddyPath}: expected ${expected}`);
  }
  pass(`${caddyPath}: static Caddyfile checks completed`);
}

function validateDockerfile() {
  const dockerfilePath = "workspace/Dockerfile.gog";
  const source = readText(dockerfilePath);
  for (const expected of [
    "ARG BASE_IMAGE=ghcr.io/openclaw/openclaw:",
    "ARG GOGCLI_VERSION=",
    "ARG GOPLACES_VERSION=",
    "ARG GH_VERSION=",
    "FROM ${BASE_IMAGE}",
    "USER root",
    "USER node",
    "/usr/local/bin/gog",
    "/usr/local/bin/goplaces",
    "/usr/local/bin/gh",
  ]) {
    assert(source.includes(expected), `${dockerfilePath}: expected ${expected}`);
  }
  assert(!/^\s*&&\s*curl\b.*latest\/download/um.test(source), `${dockerfilePath}: do not use latest/download release URLs for pinned tools`);
  pass(`${dockerfilePath}: static Dockerfile checks completed`);
}

function validateExampleConfig() {
  const config = JSON.parse(readText("config/openclaw.example.json"));
  assert(config.gateway?.auth?.mode === "token", "config/openclaw.example.json: gateway auth should use token mode in the template");
  assert(config.gateway?.auth?.token === "REPLACE_ME_LONG_HEX_GATEWAY_TOKEN", "config/openclaw.example.json: gateway token must remain a placeholder");
  assert(config.gateway?.controlUi?.dangerouslyDisableDeviceAuth === false, "config/openclaw.example.json: device auth should not be disabled in the template");
  assert(config.browser?.profiles?.browserbase?.cdpUrl?.includes("REPLACE_ME_BROWSERBASE_API_KEY"), "config/openclaw.example.json: Browserbase API key should remain a placeholder");
  pass("config/openclaw.example.json: template safety checks completed");
}

function validateGithubPrBridge() {
  const serverPath = "github-pr-bridge/server.mjs";
  const source = readText(serverPath);
  assert(source.includes('"closed"'), `${serverPath}: pull_request.closed should be treated as a relevant action`);
  assert(source.includes('"github_pr_closed"'), `${serverPath}: closed PR hooks should wake OpenClaw with a close-specific event kind`);
  assert(source.includes("Move to Done unless already in Done or Archived"), `${serverPath}: closed PR hook should move closed PR cards to Done`);
  assert(source.includes("Do not reopen"), `${serverPath}: closed PR hook instructions should not ask agents to reopen PRs`);
  pass(`${serverPath}: closed PR handling checks completed`);
}

function optionalToolChecks() {
  const docker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" });
  if (docker.status === 0) {
    try {
      execFileSync("docker", ["compose", "-f", "workspace/docker-compose.droplet.yml", "config", "--quiet"], { cwd: repoRoot, stdio: "pipe" });
      pass("docker compose config --quiet passed");
    } catch (error) {
      fail(`docker compose config --quiet failed: ${(error.stderr ?? error.message).toString().trim()}`);
    }
  } else {
    skip("docker compose not available, skipped compose CLI validation");
  }

  const caddy = spawnSync("caddy", ["version"], { encoding: "utf8" });
  if (caddy.status === 0) {
    const result = spawnSync("caddy", ["validate", "--config", "Caddyfile.droplet", "--adapter", "caddyfile"], { cwd: repoRoot, encoding: "utf8" });
    assert(result.status === 0, `caddy validate failed: ${result.stderr.trim() || result.stdout.trim()}`);
    if (result.status === 0) pass("caddy validate passed");
  } else {
    skip("caddy not available, skipped Caddy CLI validation");
  }
}

validateJsonFiles();
const yamlFiles = validateYamlFiles();
validateDeployWorkflow(yamlFiles);
validateCompose(yamlFiles);
validateTrelloGatewayDir();
validateTrelloRoutinesDir();
validateTrelloPipelineDir();
validateCaddyfile();
validateDockerfile();
validateExampleConfig();
validateGithubPrBridge();
optionalToolChecks();

console.log("\nTest gate results");
for (const message of passed) console.log(`PASS ${message}`);
for (const message of skipped) console.log(`SKIP ${message}`);

if (failures.length > 0) {
  console.error("\nFailures");
  for (const message of failures) console.error(`FAIL ${message}`);
  process.exit(1);
}

console.log("\nAll required checks passed.");
