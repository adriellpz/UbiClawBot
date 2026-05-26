import { eventToTrelloCard } from "./routine_calendar_lookup.mjs";

function evTime(ev, which) {
  const value = ev?.[which];
  if (typeof value === "string") return new Date(value).getTime();
  if (value?.dateTime) return new Date(value.dateTime).getTime();
  return new Date(value?.date || 0).getTime();
}

function isWorkEvent(ev) {
  return /^work$/i.test(String(ev?.summary || "").trim());
}

export function buildNoSlotComment({ title, preferStart, preferEnd }) {
  const windowLabel = preferEnd ? `${preferStart}-${preferEnd} MT` : `${preferStart} MT`;
  return `@adriellpz1 No clean slot was available for \"${title}\" in the prefer window (${windowLabel}). Please schedule manually.`;
}

function preferWindowBoundsMt(instanceDate, preferStart, preferEnd, durationMin) {
  const windowStart = new Date(`${instanceDate}T${preferStart}:00-06:00`);
  const minimumWindowEnd = new Date(windowStart.getTime() + durationMin * 60_000);

  if (!preferEnd) {
    return { windowStart, windowEnd: minimumWindowEnd };
  }

  const configuredWindowEnd = new Date(`${instanceDate}T${preferEnd}:00-06:00`);
  return {
    windowStart,
    windowEnd:
      configuredWindowEnd.getTime() < minimumWindowEnd.getTime() ? minimumWindowEnd : configuredWindowEnd,
  };
}

function overlapsRange(ev, startMs, endMs) {
  return evTime(ev, "start") < endMs && evTime(ev, "end") > startMs;
}

function isClaimableOverlap(ev, openCards) {
  const card = eventToTrelloCard(ev, openCards);
  if (!card) return false;
  const listName = String(card.listName || "").toLowerCase();
  return listName === "scheduled" || listName === "reschedule";
}

export function findRoutinePreferSlot({
  instanceDate,
  preferStart,
  preferEnd,
  durationMin,
  events,
  openCards = [],
  stepMinutes = 5,
}) {
  const { windowStart, windowEnd } = preferWindowBoundsMt(instanceDate, preferStart, preferEnd, durationMin);
  const stepMs = stepMinutes * 60_000;
  const latestStartMs = windowEnd.getTime() - durationMin * 60_000;

  for (let startMs = windowStart.getTime(); startMs <= latestStartMs; startMs += stepMs) {
    const endMs = startMs + durationMin * 60_000;
    const blocked = events.some(
      (ev) => !isWorkEvent(ev) && !isClaimableOverlap(ev, openCards) && overlapsRange(ev, startMs, endMs),
    );
    if (!blocked) {
      return {
        start: new Date(startMs),
        end: new Date(endMs),
        shifted: startMs !== windowStart.getTime(),
      };
    }
  }

  return {
    start: null,
    end: null,
    shifted: false,
    reason: "no_open_slot_in_prefer_window",
  };
}
