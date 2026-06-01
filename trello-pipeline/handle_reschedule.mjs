#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import process from "node:process";

import { findAllLinkedEvents } from "./calendar_lookup.mjs";
import { needsRoutineBeforeMissed, shouldRoutineMissedDuplicate } from "./handle_reschedule_logic.mjs";
import { findFreeSlot } from "./find-free-slot.mjs";
import {
  eventHtmlLink,
  formatCalendarTimeRange,
  parseTimeNeeded,
  upsertCalendarBlock,
} from "./trello_card_calendar_desc.mjs";

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com";
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "ubitheai@gmail.com";
const DEFAULT_BLOCK_MINUTES = 30;
const SEARCH_DEADLINE_DAYS = 14;
const EVENING_CUTOFF_HOUR = 20;
const MORNING_START_HOUR = 8;
const WORK_START_HOUR = 7;
const WORK_END_HOUR = 16;
const MOUNTAIN_OFFSET = -6;
const MIN_TASK_GAP_MINUTES = 60;
const LUNCH_START_HOUR = 12;
const LUNCH_END_HOUR = 13;

function argVal(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

const cardId = argVal("--card-id");
const shortLink = argVal("--short-link");
const fromList = (argVal("--from-list") || "").toLowerCase();
const dryRun = process.argv.includes("--dry-run");

if (!cardId && !shortLink) process.exit(2);

if (!process.env.TRELLO_GATEWAY_URL) throw new Error("TRELLO_GATEWAY_URL is required");
const GATEWAY_URL = process.env.TRELLO_GATEWAY_URL;
const GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;
if (!GATEWAY_KEY) {
  console.error(JSON.stringify({ error: "Missing TRELLO_GATEWAY_KEY" }));
  process.exit(2);
}

function gogEnv() {
  const env = { ...process.env };
  const gogBin = process.env.GOG_BIN || "gog";
  if (gogBin.includes("/")) {
    env.PATH = `${path.dirname(gogBin)}:${env.PATH || ""}`;
  }
  const passwordFile = process.env.GOG_KEYRING_PASSWORD_FILE || "/home/node/.openclaw/credentials/gog-keyring-password";
  if (!env.GOG_KEYRING_PASSWORD) {
    try {
      env.GOG_KEYRING_PASSWORD = fs.readFileSync(passwordFile, "utf8").trim();
    } catch {}
  }
  return env;
}

function gog(args) {
  const gogBin = process.env.GOG_BIN || "gog";
  try {
    return execFileSync(gogBin, args, { encoding: "utf8", env: gogEnv(), stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    if (/invalid_grant|Token has been expired/.test(error.stderr || "")) {
      throw new Error("GOG OAuth token expired");
    }
    throw error;
  }
}

async function gw(operation, card, params = {}) {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify({ agentId: "system", operation, cardId: card, params }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Gateway ${operation}: ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : {};
}

async function getCard(ref) {
  const data = await gw("get", ref);
  return data.card || null;
}

async function getLists() {
  const data = await gw("board_lists", "board");
  return data.lists || [];
}

function cardDuration(card) {
  return parseTimeNeeded(card.desc || "", DEFAULT_BLOCK_MINUTES);
}

async function moveCard(targetCardId, targetListName, due) {
  const params = { targetList: targetListName };
  if (due) params.due = due;
  return gw("move", targetCardId, params);
}

async function addComment(targetCardId, text) {
  return gw("comment", targetCardId, { text });
}

async function writeCalendarToDescription(card, gogOutput, slotStart, slotEnd, durationMin) {
  const link = eventHtmlLink(gogOutput);
  if (!link || !slotStart || !slotEnd) return;
  const calendarTime = formatCalendarTimeRange(slotStart, slotEnd);
  const desc = upsertCalendarBlock(card.desc || "", { link, calendarTime, timeNeeded: durationMin });
  await gw("update", card.id, { fields: { desc } });
  card.desc = desc;
}

const PROTECTED_ROUTINE_RE =
  /\b(dog walk|sciatica|planet fitness|workout|swim|swimming|ot block|ot makeup|overtime|sunday reset|take antacid|antacid|work block|^work\b|date time|drive buffer|therapy|accountability|movie monday|family visibility|shared calendar)\b/i;

function isProtectedRoutineConstraint(card, sourceList) {
  if ((sourceList || "").toLowerCase() === "routine") return false;
  const name = String(card.name || "");
  if (PROTECTED_ROUTINE_RE.test(name)) return true;
  for (const label of card.labels || []) {
    const labelName = (label.name || "").toLowerCase();
    if (labelName.includes("health") || labelName === "routine" || labelName.includes("accountability")) return true;
  }
  return false;
}

function priorityDays(labels, cardName = "") {
  const title = String(cardName || "").toUpperCase();
  if (/\bP1\b/.test(title)) return 1;
  if (/\bP3\b/.test(title)) return 5;
  if (/\bP2\b/.test(title)) return 2;
  const names = (labels || []).map((label) => (label.name || "").toLowerCase());
  if (names.some((name) => name.includes("p1") || name.includes("priority: high"))) return 1;
  if (names.some((name) => name.includes("p3") || name.includes("priority: low"))) return 5;
  return 2;
}

function nextDayAt(hour) {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function daysFromNowAt(days, hour) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(hour, 0, 0, 0);
  return date;
}

function startOfDay(date) {
  const value = new Date(date);
  value.setHours(0, 0, 0, 0);
  return value;
}

function evTime(event, field) {
  return new Date(event[field]?.dateTime || event[field]?.date || 0).getTime();
}

async function main() {
  const card = cardId ? await getCard(cardId) : await getCard(shortLink);
  if (card.closed) {
    console.log(JSON.stringify({ status: "skipped", reason: "card_closed", card: card.name }));
    return;
  }

  const lists = await getLists();
  const byName = Object.fromEntries(lists.map((list) => [list.name.toLowerCase(), list]));
  const scheduledList = byName.scheduled;
  const missedList = byName.missed;
  const routineList = byName.routine;
  if (!scheduledList) throw new Error("Scheduled list not found");

  const durationMin = cardDuration(card);
  const shortUrl = card.shortUrl || `https://trello.com/c/${card.shortLink}`;
  const preserveHour = card.due ? new Date(card.due).getHours() : 9;
  const searchDays = 90;
  const from = new Date(Date.now() - searchDays * 86400000).toISOString();
  const to = new Date(Date.now() + searchDays * 86400000).toISOString();

  let allEvents = [];
  try {
    allEvents =
      JSON.parse(
        gog([
          "calendar",
          "events",
          CALENDAR_ID,
          "--from",
          from,
          "--to",
          to,
          "--account",
          GOG_ACCOUNT,
          "--json",
          "--no-input",
          "--all-pages",
          "--max",
          "500",
        ]),
      ).events || [];
  } catch (error) {
    console.log(JSON.stringify({ status: "warning", message: "calendar_search_failed", error: error.message, card: card.name }));
  }

  const linkedEvents = findAllLinkedEvents(card, allEvents);
  let currentEvent = null;
  if (linkedEvents.length > 0) {
    const now = Date.now();
    currentEvent = linkedEvents.reduce((best, event) =>
      Math.abs(evTime(event, "start") - now) < Math.abs(evTime(best, "start") - now) ? event : best,
    );
  }

  const activityName = card.name
    .replace(/^p[123]\s*[-]\s*/i, "")
    .replace(/^R\s*-\s*/i, "")
    .replace(/\s*[-]\s*\d{4}-\d{2}-\d{2}\s*$/, "")
    .trim()
    .toLowerCase();
  const activityEvents = activityName ? allEvents.filter((event) => (event.summary || "").toLowerCase().includes(activityName)) : [];

  const tomorrowStart = startOfDay(new Date(Date.now() + 86400000));
  const tomorrowEnd = new Date(tomorrowStart.getTime() + 86400000);
  let targetList;
  let action;
  let priority;
  let slot;
  const resultBase = { fromList: fromList || "unknown", card: card.name };

  if (fromList === "routine") {
    const tomorrowEvent = [...linkedEvents, ...activityEvents].find((event) => {
      if (currentEvent && event.id === currentEvent.id) return false;
      const startMs = evTime(event, "start");
      return startMs >= tomorrowStart.getTime() && startMs < tomorrowEnd.getTime();
    });

    if (shouldRoutineMissedDuplicate(fromList, Boolean(tomorrowEvent))) {
      if (!missedList) throw new Error("Missed list not found");
      targetList = missedList;
      action = "missed_duplicate";
      priority = "routine";
      if (!dryRun) {
        if (currentEvent) {
          gog(["calendar", "delete", CALENDAR_ID, currentEvent.id, "--account", GOG_ACCOUNT, "--no-input", "--force", "--send-updates", "none"]);
        }
        if (needsRoutineBeforeMissed(card)) {
          if (!routineList) throw new Error("Routine list not found");
          await moveCard(card.id, routineList.name, card.due || undefined);
        }
        await moveCard(card.id, targetList.name, new Date().toISOString());
      }
      console.log(
        JSON.stringify({
          ...resultBase,
          status: dryRun ? "dry_run" : "ok",
          action,
          targetList: targetList.name,
          due: new Date().toISOString(),
          deletedEventId: currentEvent?.id || null,
          tomorrowEventId: tomorrowEvent.id,
          priority,
          viaRoutine: needsRoutineBeforeMissed(card),
        }),
      );
      return;
    }

    targetList = routineList || scheduledList;
    action = currentEvent ? "rescheduled_routine" : "created_routine";
    priority = "routine";
    slot = await findFreeSlot(nextDayAt(preserveHour), durationMin, allEvents, currentEvent?.id);
    if (!slot.start) {
      if (!dryRun) {
        await addComment(
          card.id,
          `@ubitheai1 @adriellopez1 Unable to find a slot for "${card.name}" in the next two weeks. Can you find a spot? If not, coordinate with each other to place this manually.`,
        );
      }
      console.log(JSON.stringify({ ...resultBase, status: dryRun ? "dry_run" : "ok", action: "escalated_no_slot", targetList: "Reschedule", reason: slot.reason, attempts: slot.attempts }));
      return;
    }

    if (!dryRun) {
      let gogResult;
      if (currentEvent) {
        gogResult = gog([
          "calendar",
          "update",
          CALENDAR_ID,
          currentEvent.id,
          "--from",
          slot.start.toISOString(),
          "--to",
          slot.end.toISOString(),
          "--account",
          GOG_ACCOUNT,
          "--no-input",
          "--send-updates",
          "none",
          "--json",
        ]);
      } else {
        gogResult = gog([
          "calendar",
          "create",
          CALENDAR_ID,
          "--summary",
          card.name,
          "--from",
          slot.start.toISOString(),
          "--to",
          slot.end.toISOString(),
          "--description",
          `${card.name}\nTrello: ${shortUrl}`,
          "--account",
          GOG_ACCOUNT,
          "--no-input",
          "--send-updates",
          "none",
          "--json",
        ]);
      }
      await moveCard(card.id, targetList.name, slot.end.toISOString());
      if (gogResult) await writeCalendarToDescription(card, gogResult, slot.start, slot.end, durationMin);
    }

    console.log(JSON.stringify({ ...resultBase, status: dryRun ? "dry_run" : "ok", action, targetList: targetList.name, due: slot.end.toISOString(), calendarEventId: currentEvent?.id || null, priority, conflictShifted: slot.shifted, conflictAttempts: slot.attempts, softOverlaps: slot.overlaps }));
    return;
  }

  if (isProtectedRoutineConstraint(card, fromList)) {
    const restoreList = routineList || scheduledList;
    if (!dryRun) {
      await addComment(card.id, "Auto-reschedule skipped: protected routine/constraint. Calendar unchanged.");
      await moveCard(card.id, restoreList.name, card.due || undefined);
    }
    console.log(JSON.stringify({ ...resultBase, status: dryRun ? "dry_run" : "skipped", reason: "protected_routine_constraint", restoredList: restoreList?.name }));
    return;
  }

  const days = priorityDays(card.labels, card.name);
  targetList = scheduledList;
  priority = days === 1 ? "P1" : days === 5 ? "P3" : "P2";
  slot = await findFreeSlot(daysFromNowAt(days, preserveHour), durationMin, allEvents, currentEvent?.id);
  action = currentEvent ? "moved_event" : "created_event";

  if (!slot.start) {
    if (!dryRun) {
      await addComment(
        card.id,
        `@ubitheai1 @adriellopez1 Unable to find a slot for "${card.name}" in the next two weeks. Can you find a spot? If not, coordinate with each other to place this manually.`,
      );
    }
    console.log(JSON.stringify({ ...resultBase, status: dryRun ? "dry_run" : "ok", action: "escalated_no_slot", targetList: "Reschedule", reason: slot.reason, attempts: slot.attempts }));
    return;
  }

  if (!dryRun) {
    let gogResult;
    if (currentEvent) {
      gogResult = gog([
        "calendar",
        "update",
        CALENDAR_ID,
        currentEvent.id,
        "--from",
        slot.start.toISOString(),
        "--to",
        slot.end.toISOString(),
        "--account",
        GOG_ACCOUNT,
        "--no-input",
        "--send-updates",
        "none",
        "--json",
      ]);
    } else {
      gogResult = gog([
        "calendar",
        "create",
        CALENDAR_ID,
        "--summary",
        card.name,
        "--from",
        slot.start.toISOString(),
        "--to",
        slot.end.toISOString(),
        "--description",
        `${card.name}\nTrello: ${shortUrl}`,
        "--account",
        GOG_ACCOUNT,
        "--no-input",
        "--send-updates",
        "none",
        "--json",
      ]);
    }
    await moveCard(card.id, targetList.name, slot.end.toISOString());
    if (gogResult) await writeCalendarToDescription(card, gogResult, slot.start, slot.end, durationMin);
  }

  console.log(JSON.stringify({ ...resultBase, status: dryRun ? "dry_run" : "ok", action, targetList: targetList.name, due: slot.end.toISOString(), calendarEventId: currentEvent?.id || null, priority, conflictShifted: slot.shifted, conflictAttempts: slot.attempts, softOverlaps: slot.overlaps }));
}

main().catch((error) => {
  console.error(JSON.stringify({ status: "error", error: error.message }));
  process.exit(1);
});
