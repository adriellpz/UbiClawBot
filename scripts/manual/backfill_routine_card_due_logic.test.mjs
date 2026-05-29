import assert from "node:assert/strict";
import test from "node:test";

import {
  dueMatchesExpected,
  eventEndIso,
  loadCalendarEventsRequired,
  parseCalendarTimeEnd,
  planRoutineDueBackfill,
} from "./backfill_routine_card_due_logic.mjs";

test("loadCalendarEventsRequired returns events from fetchEvents", () => {
  const events = [{ id: "ev1", end: { dateTime: "2026-05-27T10:30:00-06:00" } }];
  assert.deepEqual(loadCalendarEventsRequired(() => events), events);
});

test("loadCalendarEventsRequired throws when fetchEvents fails", () => {
  assert.throws(
    () => loadCalendarEventsRequired(() => {
      throw new Error("gog: auth expired");
    }),
    /Calendar fetch failed; backfill aborted\. gog: auth expired/,
  );
});

test("eventEndIso returns ISO string from calendar event end", () => {
  assert.equal(eventEndIso({ end: { dateTime: "2026-05-27T10:30:00-06:00" } }), "2026-05-27T16:30:00.000Z");
});

test("parseCalendarTimeEnd reads the end of a Calendar time line", () => {
  assert.equal(
    parseCalendarTimeEnd("2026-05-27T10:00:00-06:00 - 2026-05-27T10:30:00-06:00"),
    "2026-05-27T16:30:00.000Z",
  );
});

test("planRoutineDueBackfill updates routine cards missing due from linked event", () => {
  const result = planRoutineDueBackfill(
    {
      id: "card-1",
      name: "R - Dog walk - 2026-05-27",
      listName: "Routine",
      desc: "https://www.google.com/calendar/event?eid=abc\n\nCalendar time: 2026-05-27T10:00:00-06:00 - 2026-05-27T10:30:00-06:00",
      due: null,
    },
    {
      matchedEvents: [{ id: "ev1", end: { dateTime: "2026-05-27T10:30:00-06:00" } }],
    },
  );

  assert.equal(result.action, "update");
  assert.equal(result.due, "2026-05-27T16:30:00.000Z");
  assert.equal(result.dueSource, "calendar_event");
});

test("planRoutineDueBackfill falls back to description calendar time when no event match", () => {
  const result = planRoutineDueBackfill(
    {
      id: "card-2",
      name: "R - Dog walk - 2026-05-27",
      listName: "Routine",
      desc: "Calendar time: 2026-05-27T10:00:00-06:00 - 2026-05-27T10:30:00-06:00",
      due: null,
    },
    { matchedEvents: [] },
  );

  assert.equal(result.action, "update");
  assert.equal(result.dueSource, "description_calendar_time");
  assert.equal(result.due, "2026-05-27T16:30:00.000Z");
});

test("planRoutineDueBackfill skips when due already matches event end", () => {
  const result = planRoutineDueBackfill(
    {
      id: "card-3",
      name: "R - Dog walk - 2026-05-27",
      listName: "Routine",
      due: "2026-05-27T16:30:00.000Z",
    },
    {
      matchedEvents: [{ id: "ev1", end: { dateTime: "2026-05-27T10:30:00-06:00" } }],
    },
  );

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "due_already_correct");
});

test("planRoutineDueBackfill skips non-routine lists", () => {
  const result = planRoutineDueBackfill(
    { id: "card-4", name: "P2 - Task", listName: "Scheduled", due: null },
    { matchedEvents: [{ id: "ev1", end: { dateTime: "2026-05-27T10:30:00-06:00" } }] },
  );

  assert.equal(result.action, "skip");
  assert.equal(result.reason, "not_routine_list");
});

test("dueMatchesExpected allows a one-minute tolerance", () => {
  assert.equal(dueMatchesExpected("2026-05-27T16:30:30.000Z", "2026-05-27T16:30:00.000Z"), true);
  assert.equal(dueMatchesExpected("2026-05-27T16:32:00.000Z", "2026-05-27T16:30:00.000Z"), false);
});
