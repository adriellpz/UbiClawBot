#!/usr/bin/env node
/**
 * Redact secrets from live exports before committing to config/live/.
 *
 *   ssh myserver 'cat /root/openclaw/data/config/openclaw.json' | node scripts/sanitize-live-config.mjs openclaw
 *   ssh myserver 'cat /root/openclaw/data/config/cron/jobs.json' | node scripts/sanitize-live-config.mjs cron
 */
import { readFileSync } from "node:fs";

const mode = process.argv[2];
const input = readFileSync(0, "utf8");
const data = JSON.parse(input);

if (mode === "openclaw") {
  if (data.gateway?.auth) data.gateway.auth.token = "REPLACE_ME_LONG_HEX_GATEWAY_TOKEN";
  if (data.hooks) {
    data.hooks.token = "REPLACE_ME_HOOKS_SHARED_SECRET";
    if (data.hooks.gmail) {
      data.hooks.gmail.pushToken = "REPLACE_ME_GOOGLE_PUBSUB_VERIFICATION_TOKEN";
    }
  }
  if (data.browser?.profiles?.browserbase) {
    data.browser.profiles.browserbase.cdpUrl =
      "wss://connect.browserbase.com?apiKey=REPLACE_ME_BROWSERBASE_API_KEY&projectId=REPLACE_ME_BROWSERBASE_PROJECT_ID";
  }
  if (Array.isArray(data.commands?.ownerAllowFrom)) {
    data.commands.ownerAllowFrom = ["telegram:REPLACE_ME_TELEGRAM_USER_ID"];
  }
  if (data.auth?.profiles) {
    data.auth.profiles = {
      "openai-codex:REPLACE_ME_ACCOUNT": { provider: "openai-codex", mode: "oauth" },
      "opencode:default": { provider: "opencode", mode: "api_key" },
      "opencode-go:default": { provider: "opencode-go", mode: "api_key" },
    };
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
} else if (mode === "cron") {
  for (const job of data.jobs ?? []) {
    delete job.state;
    delete job.lastRunAtMs;
    delete job.lastStatus;
    delete job.lastDurationMs;
    delete job.lastError;
  }
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
} else {
  console.error("Usage: sanitize-live-config.mjs openclaw|cron < input.json");
  process.exit(1);
}
