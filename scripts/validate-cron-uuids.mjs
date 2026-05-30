#!/usr/bin/env node
/**
 * Validate cron job UUIDs in config/live/cron/jobs.json.
 *
 * Checks:
 * 1. All jobs have a valid v4 UUID (no placeholder/fake UUIDs like a3c8...)
 * 2. No duplicate UUIDs
 * 3. UUIDs are hardcoded strings (not generated at build time)
 *
 * Usage:
 *   node scripts/validate-cron-uuids.mjs
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cronPath = resolve(repoRoot, "config/live/cron/jobs.json");

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Known fake/placeholder UUIDs that should never appear
const FAKE_UUIDS = new Set([
  "a3c8f1e2-9b4d-4a7c-8e6f-1d2c3b4a5e6f",  // sequential fake
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);

let exitCode = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  exitCode = 1;
}

try {
  const data = JSON.parse(readFileSync(cronPath, "utf8"));
  if (!data.jobs || !Array.isArray(data.jobs)) {
    fail("jobs.json missing 'jobs' array");
    process.exit(1);
  }

  const seen = new Set();

  for (const job of data.jobs) {
    const { id, name } = job;

    if (!id) {
      fail(`Job "${name}" missing 'id'`);
      continue;
    }

    if (FAKE_UUIDS.has(id)) {
      fail(`Job "${name}" has fake/placeholder UUID: ${id}`);
    }

    if (!UUID_V4_RE.test(id)) {
      fail(`Job "${name}" has invalid UUID: ${id} (must be a valid v4 UUID)`);
    }

    if (seen.has(id)) {
      fail(`Duplicate UUID ${id} on jobs: "${name}" and previously seen on another job`);
    }
    seen.add(id);
  }

  if (exitCode === 0) {
    console.log(`OK: ${data.jobs.length} cron jobs, all UUIDs valid and unique.`);
  }
} catch (err) {
  fail(`Could not read/parse ${cronPath}: ${err.message}`);
}

process.exit(exitCode);
