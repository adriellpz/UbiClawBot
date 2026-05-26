import assert from "node:assert/strict";
import test from "node:test";

import { buildNoSlotComment, findRoutinePreferSlot } from "./ensure_routines_logic.mjs";

function event(summary, start, end, extras = {}) {
  return {
    summary,
    start: { dateTime: start },
    end: { dateTime: end },
    ...extras,
  };
}

test("routine shifts later inside the prefer window around a personal event", () => {
  const slot = findRoutinePreferSlot({
    instanceDate: "2026-05-27",
    preferStart: "10:00",
    preferEnd: "11:00",
    durationMin: 30,
    events: [event("Dentist", "2026-05-27T10:00:00-06:00", "2026-05-27T10:20:00-06:00")],
    openCards: [],
  });

  assert.equal(slot.start?.toISOString(), "2026-05-27T16:20:00.000Z");
  assert.equal(slot.end?.toISOString(), "2026-05-27T16:50:00.000Z");
  assert.equal(slot.shifted, true);
});

test("routine keeps the preferred slot when overlap is claimable Trello scheduled work", () => {
  const slot = findRoutinePreferSlot({
    instanceDate: "2026-05-27",
    preferStart: "10:00",
    preferEnd: "11:00",
    durationMin: 30,
    events: [
      event("Existing task", "2026-05-27T10:00:00-06:00", "2026-05-27T10:30:00-06:00", {
        description: "Trello: https://trello.com/c/Claim123",
      }),
    ],
    openCards: [
      {
        id: "card-1",
        name: "P2 - Existing task",
        listName: "Scheduled",
        shortUrl: "https://trello.com/c/Claim123",
        shortLink: "Claim123",
        desc: "",
      },
    ],
  });

  assert.equal(slot.start?.toISOString(), "2026-05-27T16:00:00.000Z");
  assert.equal(slot.end?.toISOString(), "2026-05-27T16:30:00.000Z");
  assert.equal(slot.shifted, false);
});

test("manual-scheduling comment tags adriellpz1 with the prefer window", () => {
  const text = buildNoSlotComment({
    title: "R - Dog walk - 2026-05-27",
    preferStart: "10:00",
    preferEnd: "11:00",
  });

  assert.match(text, /@adriellpz1/);
  assert.match(text, /R - Dog walk - 2026-05-27/);
  assert.match(text, /10:00-11:00 MT/);
  assert.match(text, /schedule manually/i);
});

test("routine ignores Work overlap inside the prefer window", () => {
  const slot = findRoutinePreferSlot({
    instanceDate: "2026-05-27",
    preferStart: "10:00",
    preferEnd: "11:00",
    durationMin: 30,
    events: [event("Work", "2026-05-27T07:00:00-06:00", "2026-05-27T16:00:00-06:00")],
    openCards: [],
  });

  assert.equal(slot.start?.toISOString(), "2026-05-27T16:00:00.000Z");
  assert.equal(slot.end?.toISOString(), "2026-05-27T16:30:00.000Z");
  assert.equal(slot.shifted, false);
});
