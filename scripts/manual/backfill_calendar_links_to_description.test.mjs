#!/usr/bin/env node
import assert from "node:assert/strict";

import { calendarLinks, firstNonEmptyLine } from "../../trello-pipeline/trello_card_calendar_desc.mjs";
import { planDescriptionBackfill } from "./backfill_calendar_links_to_description_logic.mjs";

const LINK = "https://www.google.com/calendar/event?eid=abc123";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}:`, error.message);
    process.exitCode = 1;
  }
}

test("falls back to single matched calendar event link", () => {
  const card = {
    name: "P2 - Historical scheduled card",
    desc: [
      "Time needed: 45",
      "",
      "Original Request:",
      "Review package",
      "",
      "Research:",
      "Matched the historical calendar event.",
      "",
      "Peer Review:",
      "",
      "Work completed:",
      "",
    ].join("\n"),
  };
  const matchedEvents = [
    {
      id: "ev1",
      htmlLink: LINK,
      start: { dateTime: "2026-05-28T08:00:00-06:00" },
      end: { dateTime: "2026-05-28T08:45:00-06:00" },
    },
  ];

  const result = planDescriptionBackfill(card, { matchedEvents });

  assert.equal(result.action, "update");
  assert.equal(result.linkSource, "calendar_event");
  assert.equal(result.usedCalendarFallback, true);
  assert.equal(firstNonEmptyLine(result.newDesc), LINK);
  assert.equal(calendarLinks(result.newDesc).length, 1);
  assert.match(result.newDesc, /Calendar time:/);
  assert.match(result.newDesc, /Time needed: 45/);
  assert.match(result.newDesc, /Original Request/);
});

test("reports ambiguity when multiple calendar events match and no stored link exists", () => {
  const card = {
    name: "P2 - Ambiguous historical card",
    desc: "Original Request:\nReview package",
  };
  const matchedEvents = [
    { id: "ev1", htmlLink: "https://www.google.com/calendar/event?eid=one" },
    { id: "ev2", htmlLink: "https://www.google.com/calendar/event?eid=two" },
  ];

  const result = planDescriptionBackfill(card, { matchedEvents });

  assert.deepEqual(result, {
    action: "issue",
    reason: "ambiguous_calendar_match",
    matchedEvents: 2,
  });
});

test("flags partial legacy bodies instead of writing a noncompliant backfill", () => {
  const card = {
    name: "P2 - Legacy card",
    desc: "Original Request:\nReview package",
  };

  const result = planDescriptionBackfill(card, { cfTime: 30, matchedEvents: [] });

  assert.deepEqual(result, {
    action: "issue",
    reason: "body_contract_incomplete",
  });
});

console.log(`\n${passed} tests passed`);
if (process.exitCode) process.exit(process.exitCode);
