import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeCron } from "./scripts/sync-live-config.mjs";

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
