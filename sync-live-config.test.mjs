import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeCron } from "./scripts/sync-live-config.mjs";

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
