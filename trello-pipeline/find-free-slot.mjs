const SEARCH_DEADLINE_DAYS = 14;
const EVENING_CUTOFF_HOUR = 20;
const MORNING_START_HOUR = 8;
const WORK_START_HOUR = 7;
const WORK_END_HOUR = 16;
const MOUNTAIN_OFFSET = -6;
const MIN_TASK_GAP_MINUTES = 60;
const LUNCH_START_HOUR = 12;
const LUNCH_END_HOUR = 13;

function evTime(event, field) {
  return new Date(event[field]?.dateTime || event[field]?.date || 0).getTime();
}

function toMountain(date) {
  const value = new Date(date);
  value.setHours(value.getHours() + MOUNTAIN_OFFSET);
  return value;
}

function isAfterCutoff(endTime) {
  const mountain = toMountain(endTime);
  return mountain.getHours() >= EVENING_CUTOFF_HOUR || mountain.getHours() < MORNING_START_HOUR;
}

function isWorkHours(endTime) {
  const mountain = toMountain(endTime);
  const day = mountain.getDay();
  const hour = mountain.getHours();
  return day >= 1 && day <= 5 && hour >= WORK_START_HOUR && hour < WORK_END_HOUR;
}

function isWorkEvent(event) {
  return /^work$/i.test(String(event.summary || "").trim());
}

function eventsOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function gapMinutes(aStart, aEnd, bStart, bEnd) {
  if (eventsOverlap(aStart, aEnd, bStart, bEnd)) return -1;
  return aEnd <= bStart ? (bStart - aEnd) / 60000 : (aStart - bEnd) / 60000;
}

function isHardConflict(event) {
  if (event.location && event.location.trim()) return true;
  const text = `${event.summary || ""} ${event.description || ""}`.toLowerCase();
  return ["address", "drive", "commute", "on-site", "onsite", "in office", "in-office", "appointment"].some((hint) =>
    text.includes(hint),
  );
}

function overlapsLunch(slotStart, slotEnd) {
  const day = new Date(slotStart);
  day.setHours(0, 0, 0, 0);
  const lunchStart = new Date(day);
  lunchStart.setHours(LUNCH_START_HOUR - MOUNTAIN_OFFSET, 0, 0, 0);
  const lunchEnd = new Date(day);
  lunchEnd.setHours(LUNCH_END_HOUR - MOUNTAIN_OFFSET, 0, 0, 0);
  return slotStart < lunchEnd.getTime() && lunchStart.getTime() < slotEnd;
}

function nextMorningAfter(date) {
  const mountain = toMountain(date);
  mountain.setDate(mountain.getDate() + 1);
  mountain.setHours(MORNING_START_HOUR, 0, 0, 0);
  const utc = new Date(mountain);
  utc.setHours(utc.getHours() - MOUNTAIN_OFFSET);
  return utc;
}

function countEventsInWindow(slotStart, existingEvents, excludeEventId, startHour, endHour) {
  const mountain = new Date(slotStart.getTime() + MOUNTAIN_OFFSET * 3600000);
  const midnightMountain = new Date(mountain.getFullYear(), mountain.getMonth(), mountain.getDate());
  const midnightUtc = midnightMountain.getTime() - MOUNTAIN_OFFSET * 3600000;
  const windowStart = midnightUtc + startHour * 3600000;
  const windowEnd = midnightUtc + endHour * 3600000;

  return existingEvents.filter((event) => {
    if (excludeEventId && event.id === excludeEventId) return false;
    if (isWorkEvent(event)) return false;
    const eventStart = evTime(event, "start");
    const eventEnd = evTime(event, "end");
    return eventStart < windowEnd && windowStart < eventEnd;
  }).length;
}

function hasAddressBufferConflict(slotStart, slotEnd, existingEvents, excludeEventId) {
  const bufferMs = 30 * 60000;
  return existingEvents.some((event) => {
    if (excludeEventId && event.id === excludeEventId) return false;
    if (!isHardConflict(event)) return false;
    const eventStart = evTime(event, "start");
    const eventEnd = evTime(event, "end");
    return slotStart < eventEnd + bufferMs && eventStart - bufferMs < slotEnd;
  });
}

function nextAfterBlockLimit(slotStart, durationMin, existingEvents, excludeEventId) {
  const gap30 = 30 * 60000;
  const maxBlock = 2.5 * 3600000;
  const mountain = new Date(slotStart.getTime() + MOUNTAIN_OFFSET * 3600000);
  const dayStart = new Date(mountain.getFullYear(), mountain.getMonth(), mountain.getDate());
  const midnightUtc = dayStart.getTime() - MOUNTAIN_OFFSET * 3600000;
  const dayEndUtc = midnightUtc + 86400000;

  const dayEvents = existingEvents
    .filter((event) => {
      if (excludeEventId && event.id === excludeEventId) return false;
      const eventStart = evTime(event, "start");
      const eventEnd = evTime(event, "end");
      return eventStart < dayEndUtc && midnightUtc < eventEnd;
    })
    .map((event) => ({ start: evTime(event, "start"), end: evTime(event, "end") }))
    .sort((a, b) => a.start - b.start);

  const proposedStart = slotStart.getTime();
  const proposedEnd = proposedStart + durationMin * 60000;
  const merged = [...dayEvents, { start: proposedStart, end: proposedEnd }].sort((a, b) => a.start - b.start);
  if (merged.length === 0) return null;

  const blocks = [];
  let blockStart = merged[0].start;
  let blockEnd = merged[0].end;
  for (let index = 1; index < merged.length; index++) {
    const event = merged[index];
    if (event.start - blockEnd <= gap30) {
      blockEnd = Math.max(blockEnd, event.end);
    } else {
      blocks.push({ start: blockStart, end: blockEnd });
      blockStart = event.start;
      blockEnd = event.end;
    }
  }
  blocks.push({ start: blockStart, end: blockEnd });

  for (const block of blocks) {
    if (proposedStart < block.end && block.start < proposedEnd) {
      if (block.end - block.start > maxBlock) return block.end + 31 * 60000;
      break;
    }
  }

  return null;
}

export async function findFreeSlot(startTime, durationMin, existingEvents, excludeEventId) {
  const deadline = Date.now() + SEARCH_DEADLINE_DAYS * 86400000;
  let cursor = new Date(startTime);
  let attempt = 0;

  while (true) {
    const startMs = cursor.getTime();
    if (startMs > deadline) {
      return { start: null, end: null, reason: "no_slot_within_two_weeks", attempts: attempt, overlaps: 0 };
    }
    const endMs = startMs + durationMin * 60000;

    if (isAfterCutoff(new Date(endMs))) {
      cursor = nextMorningAfter(cursor);
      continue;
    }

    if (toMountain(cursor).getDay() === 0) {
      cursor = nextMorningAfter(cursor);
      continue;
    }

    if (isWorkHours(endMs)) {
      const mountainHour = toMountain(new Date(endMs)).getHours();
      let advanceHour = null;
      if (mountainHour < LUNCH_START_HOUR) {
        const preCount = countEventsInWindow(cursor, existingEvents, excludeEventId, WORK_START_HOUR, LUNCH_START_HOUR);
        if (preCount >= 3) advanceHour = LUNCH_END_HOUR;
      } else if (mountainHour >= LUNCH_END_HOUR) {
        const postCount = countEventsInWindow(cursor, existingEvents, excludeEventId, LUNCH_END_HOUR, WORK_END_HOUR);
        if (postCount >= 1) advanceHour = WORK_END_HOUR;
      }
      if (advanceHour !== null) {
        const day = new Date(cursor);
        day.setHours(0, 0, 0, 0);
        cursor = new Date(day);
        cursor.setHours(advanceHour - MOUNTAIN_OFFSET, 1, 0, 0);
        if (isAfterCutoff(new Date(cursor.getTime() + durationMin * 60000))) {
          cursor = nextMorningAfter(cursor);
        }
        continue;
      }
    }

    if (overlapsLunch(startMs, endMs)) {
      const day = new Date(cursor);
      day.setHours(0, 0, 0, 0);
      cursor = new Date(day);
      cursor.setHours(LUNCH_END_HOUR - MOUNTAIN_OFFSET, 1, 0, 0);
      continue;
    }

    const mountainStart = toMountain(cursor);
    if (mountainStart.getHours() === WORK_END_HOUR && mountainStart.getMinutes() < 31) {
      const day = new Date(cursor);
      day.setHours(0, 0, 0, 0);
      cursor = new Date(day);
      cursor.setHours(WORK_END_HOUR - MOUNTAIN_OFFSET, 31, 0, 0);
      if (isAfterCutoff(new Date(cursor.getTime() + durationMin * 60000))) cursor = nextMorningAfter(cursor);
      continue;
    }

    const overlapping = existingEvents.filter((event) => {
      if (excludeEventId && event.id === excludeEventId) return false;
      return eventsOverlap(startMs, endMs, evTime(event, "start"), evTime(event, "end"));
    });
    const personalOverlaps = overlapping.filter((event) => !isWorkEvent(event));

    if (isWorkHours(endMs)) {
      const tooClose = personalOverlaps.filter((event) => {
        const gap = gapMinutes(startMs, endMs, evTime(event, "start"), evTime(event, "end"));
        return gap >= 0 && gap < MIN_TASK_GAP_MINUTES;
      });
      if (tooClose.length > 0) {
        const latestEnd = Math.max(...tooClose.map((event) => evTime(event, "end")));
        cursor = new Date(latestEnd + (MIN_TASK_GAP_MINUTES + 1) * 60000);
        if (isAfterCutoff(new Date(cursor.getTime() + durationMin * 60000))) cursor = nextMorningAfter(cursor);
        continue;
      }
    }

    if (personalOverlaps.length > 0) {
      const latestEnd = Math.max(...personalOverlaps.map((event) => evTime(event, "end")));
      cursor = new Date(latestEnd + 60000);
      attempt += 1;
      continue;
    }

    if (hasAddressBufferConflict(startMs, endMs, existingEvents, excludeEventId)) {
      const bufferMs = 30 * 60000;
      const buffered = existingEvents.filter((event) => {
        if (excludeEventId && event.id === excludeEventId) return false;
        if (!isHardConflict(event)) return false;
        const eventStart = evTime(event, "start");
        const eventEnd = evTime(event, "end");
        return startMs < eventEnd + bufferMs && eventStart - bufferMs < endMs;
      });
      const latestEnd = buffered.length > 0 ? Math.max(...buffered.map((event) => evTime(event, "end") + bufferMs)) : 0;
      cursor = new Date(latestEnd + 60000);
      attempt += 1;
      continue;
    }

    if (existingEvents.length > 0 && !isWorkHours(endMs)) {
      const afterBlock = nextAfterBlockLimit(cursor, durationMin, existingEvents, excludeEventId);
      if (afterBlock !== null) {
        cursor = new Date(afterBlock);
        if (isAfterCutoff(new Date(cursor.getTime() + durationMin * 60000))) cursor = nextMorningAfter(cursor);
        attempt += 1;
        continue;
      }
    }

    return {
      start: cursor,
      end: new Date(endMs),
      shifted: attempt > 0,
      attempts: attempt,
      overlaps: overlapping.length,
    };
  }
}
