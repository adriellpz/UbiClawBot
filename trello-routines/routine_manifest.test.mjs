import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const manifestPath = path.join(path.dirname(new URL(import.meta.url).pathname), "routine_manifest.json");

test("local routines manifest carries the current production routines", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  assert.equal(manifest.routines.length, 5);
  assert.ok(manifest.routines.every((routine) => routine.title_template.startsWith("R - ")));
  assert.ok(manifest.routines.some((routine) => routine.id === "dog_walk"));
  assert.ok(manifest.routines.some((routine) => routine.id === "sciatica_15"));
  assert.ok(manifest.routines.some((routine) => routine.id === "sciatica_30"));
  assert.ok(manifest.routines.some((routine) => routine.id === "workout"));
  assert.ok(manifest.routines.some((routine) => routine.id === "submit_timesheet"));
});
