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
  assert(Array.isArray(workflow.on?.push?.branches) && workflow.on.push.branches.includes("main"), `${workflowPath}: deploy push trigger must be limited to main`);
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
  assert(typeof script === "string" && script.includes("trello-gateway"), `${workflowPath}: deploy script should copy and restart trello-gateway`);
  assert(typeof script === "string" && script.includes("trello-queue-worker"), `${workflowPath}: deploy script should restart trello-queue-worker`);

  if (typeof script === "string") {
    const composeUpLine = script.split("\n").find((line) => /docker\s+compose\s+up\b/u.test(line));
    assert(composeUpLine?.includes("trello-bridge"), `${workflowPath}: docker compose up should restart trello-bridge`);
    assert(composeUpLine?.includes("github-pr-bridge"), `${workflowPath}: docker compose up should restart github-pr-bridge`);
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
  for (const service of ["openclaw-gateway", "openclaw-cli", "trello-bridge", "github-pr-bridge", "trello-gateway", "trello-queue-worker"]) {
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
  assert(gateway.healthcheck?.test, `${composePath}: gateway should keep a healthcheck`);

  const cli = services["openclaw-cli"] ?? {};
  assert(cli.network_mode === "service:openclaw-gateway", `${composePath}: cli should share gateway network namespace`);
  assert(Array.isArray(cli.cap_drop) && cli.cap_drop.includes("NET_RAW") && cli.cap_drop.includes("NET_ADMIN"), `${composePath}: cli should drop network admin capabilities`);
  assert(Array.isArray(cli.security_opt) && cli.security_opt.includes("no-new-privileges:true"), `${composePath}: cli should set no-new-privileges`);

  const trelloBridge = services["trello-bridge"] ?? {};
  assert(trelloBridge.network_mode === "service:openclaw-gateway", `${composePath}: trello-bridge should share gateway network namespace`);
  assert(trelloBridge.working_dir === "/home/node/.openclaw/workspace/trello_bridge", `${composePath}: trello-bridge working_dir should stay explicit`);

  const githubPrBridge = services["github-pr-bridge"] ?? {};
  assert(githubPrBridge.network_mode === "service:openclaw-gateway", `${composePath}: github-pr-bridge should share gateway network namespace`);
  assert(githubPrBridge.working_dir === "/opt/github-pr-bridge", `${composePath}: github-pr-bridge working_dir should stay explicit`);
  assert(githubPrBridge.command?.includes("server.mjs"), `${composePath}: github-pr-bridge should run server.mjs`);

  const trelloGateway = services["trello-gateway"] ?? {};
  assert(trelloGateway.build?.context === "./trello-gateway", `${composePath}: trello-gateway should build from ./trello-gateway`);
  assert(trelloGateway.image === "trello-gateway:local", `${composePath}: trello-gateway image tag should stay explicit`);
  assert(trelloGateway.healthcheck?.test, `${composePath}: trello-gateway should keep a healthcheck`);
  assert(String(trelloGateway.ports?.[0] ?? "").startsWith("127.0.0.1:18792"), `${composePath}: trello-gateway should bind 127.0.0.1:18792 on the host`);

  const trelloQueueWorker = services["trello-queue-worker"] ?? {};
  assert(trelloQueueWorker.working_dir === "/home/node/.openclaw/workspace/trello_bridge", `${composePath}: trello-queue-worker working_dir should stay explicit`);
  assert(trelloQueueWorker.command?.includes("start_queue_worker.mjs"), `${composePath}: trello-queue-worker should run start_queue_worker.mjs`);
  assert(trelloQueueWorker.healthcheck?.test, `${composePath}: trello-queue-worker should keep a healthcheck`);
  const workerHealth = JSON.stringify(trelloQueueWorker.healthcheck?.test ?? []);
  assert(!workerHealth.includes("18789"), `${composePath}: trello-queue-worker healthcheck must not probe openclaw-gateway port 18789`);
  assert(workerHealth.includes("queue_worker.pid"), `${composePath}: trello-queue-worker healthcheck should verify worker pid files`);
  assert(trelloQueueWorker.depends_on?.["trello-gateway"]?.condition === "service_healthy", `${composePath}: trello-queue-worker should wait for trello-gateway health`);
}

function validateTrelloGatewayDir() {
  const dir = "trello-gateway";
  for (const file of ["Dockerfile", "deploy.sh", "trello_gateway.mjs", "trello_transition_matrix.csv", "README.md", ".env.example"]) {
    assert(existsSync(path.join(repoRoot, dir, file)), `${dir}/${file}: expected tracked gateway file`);
  }

  const gitignore = readText(".gitignore");
  assert(gitignore.includes("trello-gateway/.env"), ".gitignore: trello-gateway/.env must stay ignored");

  const deployScript = readText(`${dir}/deploy.sh`);
  assert(deployScript.includes("set -eu"), "trello-gateway/deploy.sh: should use set -eu");
  assert(!deployScript.includes(".env.example") || deployScript.includes("copy from trello-gateway/.env.example"), "trello-gateway/deploy.sh: should not overwrite live .env");
  pass("trello-gateway/: static directory checks completed");
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
validateCaddyfile();
validateDockerfile();
validateExampleConfig();
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
