import assert from "node:assert/strict";
import test from "node:test";

import { findFreeSlot } from "./find-free-slot.mjs";

// NOTE: findFreeSlot uses setHours() for timezone math, which assumes system tz = UTC.
// Run all tests in this file with TZ=UTC.

// Tuesday 2026-06-02 10:00 MT = 16:00 UTC (well within work hours)
const TUE_10AM_MT = new Date("2026-06-02T16:00:00.000Z");

function event(id, startIso, endIso, summary = "Some task", extra = {}) {
  return { id, summary, start: { dateTime: startIso }, end: { dateTime: endIso }, ...extra };
}

test("clear calendar: slot starts at startTime", async () => {
  const slot = await findFreeSlot(TUE_10AM_MT, 30, [], null);
  assert.ok(slot.start, "expected a slot");
  assert.equal(slot.start.getTime(), TUE_10AM_MT.getTime());
  assert.equal(slot.end.getTime(), TUE_10AM_MT.getTime() + 30 * 60000);
  assert.equal(slot.shifted, false);
  assert.equal(slot.attempts, 0);
});

// NOTE: The tooClose/gap-enforcement block in findFreeSlot is dead code — it filters
// personalOverlaps (which are actual overlaps), but gapMinutes() returns -1 for
// overlapping pairs, so gap >= 0 is never true. Not tested here; flag for Candidate 2 cleanup.

test("no slot in two weeks: returns start null with reason", async () => {
  // Start 15 days in the future — past the 14-day deadline, so first check fails immediately
  const twoWeeksAgo = new Date(Date.now() + 15 * 86400000);
  const slot = await findFreeSlot(twoWeeksAgo, 30, [], null);
  assert.equal(slot.start, null);
  assert.equal(slot.end, null);
  assert.equal(slot.reason, "no_slot_within_two_weeks");
  assert.ok(typeof slot.attempts === "number");
});

test("work hours post-lunch: one event in afternoon window skips to past work end (4pm MT)", async () => {
  // One event in post-lunch window: 2pm–2:30pm MT = 20:00–20:30 UTC
  const afternoon = event("e3", "2026-06-02T20:00:00Z", "2026-06-02T20:30:00Z");
  // Start at 1:30pm MT = 19:30 UTC (in post-lunch work hours, post-lunch window has 1 event)
  const tue130pm = new Date("2026-06-02T19:30:00.000Z");
  const slot = await findFreeSlot(tue130pm, 30, [afternoon], null);
  assert.ok(slot.start, "expected a slot");
  // post-lunch density ≥1 → skip to WORK_END_HOUR (4pm MT = 22:00 UTC)
  const workEnd = new Date("2026-06-02T22:00:00.000Z");
  assert.ok(slot.start.getTime() >= workEnd.getTime(), "slot should be at or after work end (4pm MT)");
});

test("lunch overlap (12–1pm MT): skips to 1pm MT", async () => {
  // Tuesday 2026-06-02 11:45am MT = 17:45 UTC — a 30-min slot straddles noon
  const tue1145am = new Date("2026-06-02T17:45:00.000Z");
  const slot = await findFreeSlot(tue1145am, 30, [], null);
  assert.ok(slot.start, "expected a slot");
  // 1:01 PM MT = 19:01 UTC (lunch end is 13:00 MT = 19:00 UTC, cursor set to 19:01)
  const tue1pm = new Date("2026-06-02T19:01:00.000Z");
  assert.equal(slot.start.getTime(), tue1pm.getTime());
});

test("after-cutoff (past 8pm MT): advances to next morning 8am MT", async () => {
  // Tuesday 2026-06-02 9:00 PM MT = 03:00 UTC next day (past 8pm cutoff)
  const tue9pm = new Date("2026-06-03T03:00:00.000Z");
  const slot = await findFreeSlot(tue9pm, 30, [], null);
  assert.ok(slot.start, "expected a slot");
  // Should land Wednesday 2026-06-03 8am MT = 14:00 UTC
  const wed8am = new Date("2026-06-03T14:00:00.000Z");
  assert.equal(slot.start.getTime(), wed8am.getTime());
});

test("Sunday: advances to Monday 8am MT", async () => {
  // Sunday 2026-06-07 10:00 MT = 16:00 UTC
  const sunday10am = new Date("2026-06-07T16:00:00.000Z");
  const slot = await findFreeSlot(sunday10am, 30, [], null);
  assert.ok(slot.start, "expected a slot");
  // Should land on Monday 2026-06-08 at 8:00 MT = 14:00 UTC
  const mon8am = new Date("2026-06-08T14:00:00.000Z");
  assert.equal(slot.start.getTime(), mon8am.getTime());
});

test("overlapping event: cursor advances past event end", async () => {
  // Event blocks 10:00–11:00 MT (16:00–17:00 UTC)
  const blocker = event("e1", "2026-06-02T16:00:00Z", "2026-06-02T17:00:00Z");
  const slot = await findFreeSlot(TUE_10AM_MT, 30, [blocker], null);
  assert.ok(slot.start, "expected a slot");
  // Slot must start at or after event end (17:00 UTC = 11:00 MT)
  assert.ok(slot.start.getTime() >= new Date("2026-06-02T17:00:00Z").getTime(), "slot should be after blocker end");
  assert.equal(slot.shifted, true);
  assert.ok(slot.attempts >= 1);
});
