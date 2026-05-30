#!/usr/bin/env node
/**
 * Apply config/live/ to droplet OpenClaw paths, preserving runtime secrets and cron state.
 *
 * Run on droplet after deploy:
 *   cd /home/deploy/openclaw && bash scripts/sync-live-config.sh
 *
 * Or from laptop:
 *   ssh myserver 'cd /home/deploy/openclaw && bash scripts/sync-live-config.sh'
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const REPO_ROOT = process.env.OPENCLAW_DEPLOY_ROOT ?? "/home/deploy/openclaw";
const LIVE_CONFIG_ROOT = process.env.OPENCLAW_CONFIG_DIR ?? "/root/openclaw/data/config";
const LIVE_DIR = path.join(REPO_ROOT, "config", "live");

const SECRET_PATHS = [
  ["gateway", "auth", "token"],
  ["hooks", "token"],
  ["hooks", "gmail", "pushToken"],
  ["browser", "profiles", "browserbase", "cdpUrl"],
];

function getAt(obj, keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAt(obj, keys, value) {
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== "object") cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function deepMerge(base, overlay) {
  if (overlay == null) return base;
  if (Array.isArray(overlay)) return overlay.map((item) => (item && typeof item === "object" ? deepMerge({}, item) : item));
  if (typeof overlay !== "object") return overlay;
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === "object" && !Array.isArray(value) && base?.[key] && typeof base[key] === "object" && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

function mergeOpenclaw(livePath, templatePath, outPath) {
  const live = JSON.parse(readFileSync(livePath, "utf8"));
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  const merged = deepMerge(live, template);
  for (const keys of SECRET_PATHS) {
    const preserved = getAt(live, keys);
    if (preserved !== undefined) setAt(merged, keys, preserved);
  }
  if (live.commands?.ownerAllowFrom) merged.commands ??= {}, merged.commands.ownerAllowFrom = live.commands.ownerAllowFrom;
  if (live.auth?.profiles) merged.auth ??= {}, merged.auth.profiles = live.auth.profiles;
  writeFileSync(outPath, `${JSON.stringify(merged, null, 2)}\n`);
}

function mergeCron(livePath, templatePath, outPath) {
  const live = JSON.parse(readFileSync(livePath, "utf8"));
  const template = JSON.parse(readFileSync(templatePath, "utf8"));
  const liveById = new Map((live.jobs ?? []).map((job) => [job.id, job]));
  const jobs = (template.jobs ?? []).map((job) => {
    const prev = liveById.get(job.id);
    if (!prev) return job;
    return { ...job, state: prev.state ?? job.state };
  });
  writeFileSync(outPath, `${JSON.stringify({ ...template, jobs }, null, 2)}\n`);
}

export { mergeCron, deepMerge };

function main() {
  if (!existsSync(LIVE_DIR)) {
    console.error(`Missing ${LIVE_DIR} — deploy repo first.`);
    process.exit(1);
  }
  mkdirSync(path.join(LIVE_CONFIG_ROOT, "hooks", "transforms"), { recursive: true });

  const openclawLive = path.join(LIVE_CONFIG_ROOT, "openclaw.json");
  const openclawTemplate = path.join(LIVE_DIR, "openclaw.json");
  if (existsSync(openclawTemplate)) {
    mergeOpenclaw(openclawLive, openclawTemplate, openclawLive);
    console.log("synced openclaw.json (secrets preserved)");
  }

  const cronLive = path.join(LIVE_CONFIG_ROOT, "cron", "jobs.json");
  const cronTemplate = path.join(LIVE_DIR, "cron", "jobs.json");
  mkdirSync(path.dirname(cronLive), { recursive: true });
  if (existsSync(cronTemplate)) {
    if (existsSync(cronLive)) mergeCron(cronLive, cronTemplate, cronLive);
    else copyFileSync(cronTemplate, cronLive);
    console.log("synced cron/jobs.json (job state preserved)");
  }

  const transformsSrc = path.join(LIVE_DIR, "hooks", "transforms");
  if (existsSync(transformsSrc)) {
    cpSync(transformsSrc, path.join(LIVE_CONFIG_ROOT, "hooks", "transforms"), { recursive: true });
    console.log("synced hooks/transforms/");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
