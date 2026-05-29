import { parseCalendarTimeLine } from "../../trello-pipeline/trello_card_calendar_desc.mjs";

export function eventEndIso(event) {
  const end = event?.end?.dateTime || event?.end?.date;
  if (!end) return null;
  const parsed = new Date(end);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function parseCalendarTimeEnd(calendarTimeLine) {
  const line = String(calendarTimeLine || "").trim();
  if (!line) return null;

  const separator = line.lastIndexOf(" - ");
  if (separator < 0) return null;

  const endPart = line.slice(separator + 3).trim();
  const parsed = new Date(endPart);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

export function dueMatchesExpected(currentDue, expectedIso, toleranceMs = 60_000) {
  if (!expectedIso) return true;
  if (!currentDue) return false;
  const currentMs = new Date(currentDue).getTime();
  const expectedMs = new Date(expectedIso).getTime();
  if (Number.isNaN(currentMs) || Number.isNaN(expectedMs)) return false;
  return Math.abs(currentMs - expectedMs) <= toleranceMs;
}

export function planRoutineDueBackfill(card, { matchedEvents = [] } = {}) {
  const listName = String(card?.listName || "").toLowerCase();
  if (listName !== "routine") {
    return { action: "skip", reason: "not_routine_list" };
  }
  if (card?.closed) {
    return { action: "skip", reason: "closed" };
  }

  let expectedDue = null;
  let dueSource = null;

  if (matchedEvents.length > 1) {
    return { action: "issue", reason: "ambiguous_calendar_match", matchedEvents: matchedEvents.length };
  }

  if (matchedEvents.length === 1) {
    expectedDue = eventEndIso(matchedEvents[0]);
    dueSource = "calendar_event";
    if (!expectedDue) {
      return { action: "issue", reason: "matched_event_missing_end" };
    }
  } else {
    expectedDue = parseCalendarTimeEnd(parseCalendarTimeLine(card?.desc || ""));
    if (expectedDue) dueSource = "description_calendar_time";
  }

  if (!expectedDue) {
    return { action: "skip", reason: "no_calendar_end" };
  }

  if (dueMatchesExpected(card?.due, expectedDue)) {
    return { action: "skip", reason: "due_already_correct", expectedDue, dueSource };
  }

  return {
    action: "update",
    due: expectedDue,
    dueSource,
    previousDue: card?.due || null,
  };
}
