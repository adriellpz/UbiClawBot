#!/usr/bin/env node
/**
 * Validate cron job UUIDs in config/live/cron/jobs.json.
 *
 * Checks:
 * 1. All jobs have a valid v4 UUID (no placeholder/fake UUIDs like a3c8...)
 * 2. No duplicate UUIDs
 * 3. With --compare-ref: same job name must keep the same id (CI drift guard)
 *
 * Usage:
 *   node scripts/validate-cron-uuids.mjs
 *   node scripts/validate-cron-uuids.mjs --compare-ref origin/main
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const cronPath = resolve(repoRoot, "config/live/cron/jobs.json");
const CRON_REL = "config/live/cron/jobs.json";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const FAKE_UUIDS = new Set([
  "a3c8f1e2-9b4d-4a7c-8e6f-1d2c3b4a5e6f",
  "00000000-0000-0000-0000-000000000000",
  "ffffffff-ffff-ffff-ffff-ffffffffffff",
]);

let exitCode = 0;

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  exitCode = 1;
}

function parseArgs(argv) {
  let compareRef = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--compare-ref" && argv[i + 1]) {
      compareRef = argv[++i];
    }
  }
  return { compareRef };
}

function loadJobsFromFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  if (!data.jobs || !Array.isArray(data.jobs)) {
    fail("jobs.json missing 'jobs' array");
    return null;
  }
  return data.jobs;
}

function loadJobsFromGit(ref) {
  try {
    const raw = execSync(`git show ${ref}:${CRON_REL}`, {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const data = JSON.parse(raw);
    return Array.isArray(data.jobs) ? data.jobs : [];
  } catch {
    return null;
  }
}

function validateJobs(jobs) {
  const seen = new Set();

  for (const job of jobs) {
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
      fail(
        `Duplicate UUID ${id} on jobs: "${name}" and previously seen on another job`,
      );
    }
    seen.add(id);
  }
}

function compareUuidStability(headJobs, baseJobs, baseRef) {
  const baseByName = new Map(
    baseJobs.filter((j) => j.name && j.id).map((j) => [j.name, j.id]),
  );

  for (const job of headJobs) {
    if (!job.name || !job.id) continue;
    const baseId = baseByName.get(job.name);
    if (baseId && baseId !== job.id) {
      fail(
        `Job "${job.name}" UUID changed (${baseId} -> ${job.id}) vs ${baseRef}. ` +
          "mergeCron matches by id; keep the existing UUID unless you are intentionally replacing the job.",
      );
    }
  }
}

const { compareRef } = parseArgs(process.argv.slice(2));

try {
  const headJobs = loadJobsFromFile(cronPath);
  if (!headJobs) {
    process.exit(exitCode || 1);
  }

  validateJobs(headJobs);

  let compared = false;
  if (compareRef) {
    const baseJobs = loadJobsFromGit(compareRef);
    if (baseJobs === null) {
      console.log(
        `SKIP: no ${CRON_REL} at ${compareRef}; UUID stability check skipped.`,
      );
    } else {
      compareUuidStability(headJobs, baseJobs, compareRef);
      compared = true;
    }
  }

  if (exitCode === 0) {
    const stability = compared ? `, stable vs ${compareRef}` : "";
    console.log(
      `OK: ${headJobs.length} cron jobs, all UUIDs valid and unique${stability}.`,
    );
  }
} catch (err) {
  fail(`Could not read/parse ${cronPath}: ${err.message}`);
}

process.exit(exitCode);
