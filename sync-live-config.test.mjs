import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeCron, mergeOpenclaw, SECRET_PATHS } from "./scripts/sync-live-config.mjs";

const repoRoot = path.dirname(fileURLToPath(import.meta.url));
const sanitizeScript = path.join(repoRoot, "scripts", "sanitize-live-config.mjs");

test("mergeCron drops live-only jobs not in config/live template", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "merge-cron-"));
  const livePath = path.join(dir, "live.json");
  const templatePath = path.join(dir, "template.json");
  const outPath = path.join(dir, "out.json");

  await writeFile(
    livePath,
    `${JSON.stringify(
      {
        version: 1,
        jobs: [
          { id: "keep-me", name: "Keep", enabled: true, state: { lastRunStatus: "ok" } },
          { id: "drop-me", name: "Stale duplicate", enabled: true },
        ],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    templatePath,
    `${JSON.stringify(
      {
        version: 1,
        jobs: [{ id: "keep-me", name: "Keep", enabled: true }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  mergeCron(livePath, templatePath, outPath);
  const merged = JSON.parse(await readFile(outPath, "utf8"));
  assert.equal(merged.jobs.length, 1);
  assert.equal(merged.jobs[0].id, "keep-me");
  assert.equal(merged.jobs[0].state.lastRunStatus, "ok");
});

test("sanitize-live-config redacts hitl cdpUrl token but preserves public hostname", () => {
  const input = JSON.stringify({
    browser: {
      profiles: {
        hitl: { cdpUrl: "wss://chrome.sonofwolf.org?token=super-secret-token", color: "#F97316" },
      },
    },
    gateway: { auth: { token: "real-gateway-token" } },
    hooks: { token: "real-hook-token" },
  });

  const result = spawnSync("node", [sanitizeScript, "openclaw"], { input, encoding: "utf8" });
  assert.equal(result.status, 0, `sanitize-live-config exited ${result.status}: ${result.stderr}`);

  const out = JSON.parse(result.stdout);
  assert.equal(
    out.browser.profiles.hitl.cdpUrl,
    "wss://chrome.sonofwolf.org?token=REPLACE_ME_BROWSERLESS_TOKEN",
    "hitl cdpUrl should preserve hostname but redact token",
  );
  assert.equal(out.gateway.auth.token, "REPLACE_ME_LONG_HEX_GATEWAY_TOKEN");
  assert.equal(out.hooks.token, "REPLACE_ME_HOOKS_SHARED_SECRET");
});

test("SECRET_PATHS includes hitl cdpUrl and not the old browserbase path", () => {
  const paths = SECRET_PATHS.map((p) => p.join("."));
  assert.ok(paths.includes("browser.profiles.hitl.cdpUrl"), "SECRET_PATHS must preserve hitl cdpUrl");
  assert.ok(!paths.includes("browser.profiles.browserbase.cdpUrl"), "SECRET_PATHS must not reference removed browserbase profile");
});

test("mergeOpenclaw strips hooks.gmail.model even when set in live config", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "merge-openclaw-gmail-"));
  const livePath = path.join(dir, "live.json");
  const templatePath = path.join(dir, "template.json");
  const outPath = path.join(dir, "out.json");

  await writeFile(livePath, JSON.stringify({
    hooks: { token: "real-hook-token", gmail: { model: "opencode-go/deepseek-v4-flash", pushToken: "real-push-token", account: "user@example.com" } },
  }, null, 2) + "\n", "utf8");

  await writeFile(templatePath, JSON.stringify({
    hooks: { token: "REPLACE_ME_HOOKS_SHARED_SECRET", gmail: { pushToken: "REPLACE_ME_GOOGLE_PUBSUB_VERIFICATION_TOKEN", account: "user@example.com" } },
  }, null, 2) + "\n", "utf8");

  const merged = mergeOpenclaw(livePath, templatePath, outPath);
  assert.equal(merged.hooks.gmail.model, undefined, "hooks.gmail.model must be stripped — it triggers the event-loop-blocking gmail-model sidecar");
  assert.equal(merged.hooks.gmail.account, "user@example.com", "other gmail fields must be preserved");
  assert.equal(merged.hooks.gmail.pushToken, "real-push-token", "gmail pushToken secret must be preserved from live config");
});

test("mergeOpenclaw preserves hitl cdpUrl from live config across sync", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "merge-openclaw-"));
  const livePath = path.join(dir, "live.json");
  const templatePath = path.join(dir, "template.json");

  await writeFile(livePath, JSON.stringify({
    gateway: { auth: { token: "real-gateway-token" } },
    hooks: { token: "real-hook-token" },
    browser: { profiles: { hitl: { cdpUrl: "wss://chrome.sonofwolf.org?token=real-secret", color: "#F97316" } } },
  }, null, 2) + "\n", "utf8");

  await writeFile(templatePath, JSON.stringify({
    gateway: { auth: { token: "REPLACE_ME_LONG_HEX_GATEWAY_TOKEN" } },
    hooks: { token: "REPLACE_ME_HOOKS_SHARED_SECRET" },
    browser: { profiles: { hitl: { cdpUrl: "wss://chrome.sonofwolf.org?token=REPLACE_ME_BROWSERLESS_TOKEN", color: "#F97316" } } },
  }, null, 2) + "\n", "utf8");

  const result = spawnSync("node", ["-e", `
    import { createRequire } from 'module';
    import { readFileSync, writeFileSync } from 'fs';
    const live = JSON.parse(readFileSync(${JSON.stringify(livePath)}, 'utf8'));
    const template = JSON.parse(readFileSync(${JSON.stringify(templatePath)}, 'utf8'));
    // Simulate mergeOpenclaw via SECRET_PATHS export
    const { SECRET_PATHS, deepMerge } = await import(${JSON.stringify(path.join(repoRoot, "scripts/sync-live-config.mjs"))});
    function getAt(o, keys) { let c = o; for (const k of keys) { if (c == null) return undefined; c = c[k]; } return c; }
    function setAt(o, keys, v) { let c = o; for (let i = 0; i < keys.length - 1; i++) { if (c[keys[i]] == null) c[keys[i]] = {}; c = c[keys[i]]; } c[keys[keys.length-1]] = v; }
    const merged = deepMerge(live, template);
    for (const keys of SECRET_PATHS) { const v = getAt(live, keys); if (v !== undefined) setAt(merged, keys, v); }
    writeFileSync(${JSON.stringify(path.join(dir, "out.json"))}, JSON.stringify(merged, null, 2) + '\\n');
  `], { encoding: "utf8" });

  const out = JSON.parse(await readFile(path.join(dir, "out.json"), "utf8"));
  assert.equal(out.browser.profiles.hitl.cdpUrl, "wss://chrome.sonofwolf.org?token=real-secret", "hitl cdpUrl must be preserved from live config, not overwritten by template");
  assert.equal(out.gateway.auth.token, "real-gateway-token", "gateway token must be preserved");
});
