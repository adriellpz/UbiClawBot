#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildNoSlotComment, findRoutinePreferSlot } from "./ensure_routines_logic.mjs";
import { buildDescription, eventHtmlLink, formatCalendarTimeRange } from "./trello_card_calendar_desc.mjs";
import { buildNextStepsChecklist, buildOpenCardDescription } from "./trello_open_card_contract.mjs";
import { eventToTrelloCard, parseRoutineTags } from "./routine_calendar_lookup.mjs";
import { boardOpenCards, comment, createCard, getCard, moveCard, styleCard, updateCard } from "./trello_gateway_module.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MANIFEST_PATH = path.join(__dirname, "routine_manifest.json");
const AGENT_ID = "system";
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com";
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "ubitheai@gmail.com";

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : null;
}

function mtDateStr(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

function mtDayCode(date) {
  const short = date.toLocaleDateString("en-US", { timeZone: "America/Denver", weekday: "short" });
  const dayMap = { Sun: "SUN", Mon: "MON", Tue: "TUE", Wed: "WED", Thu: "THU", Fri: "FRI", Sat: "SAT" };
  return dayMap[short] || short.toUpperCase().slice(0, 3);
}

function habitApplies(habit, date) {
  if (habit.recurrence === "daily") return true;
  if (habit.recurrence === "weekly") return (habit.days || []).includes(mtDayCode(date));
  return false;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function gog(argv) {
  const env = { ...process.env };
  env.PATH = `${path.dirname(process.env.GOG_BIN || "gog")}:${env.PATH || ""}`;
  return execFileSync(process.env.GOG_BIN || "gog", argv, {
    encoding: "utf8",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function buildCardDescription(habit, period, link = "", calendarTime = "") {
  const researchLines = [
    "Routine instance generated from the routine manifest.",
    `routine-id: ${habit.id}`,
    `routine-period: ${period}`,
  ];
  if (habit.description_note) {
    researchLines.push("", habit.description_note);
  }

  const body = buildOpenCardDescription({
    originalRequest: habit.title_template.replace("{date}", period),
    research: researchLines,
  });

  return buildDescription({
    link,
    calendarTime,
    timeNeeded: habit.duration_minutes,
    body,
  });
}

function createCalendarEvent(title, slot, trelloUrl) {
  const output = gog([
    "calendar",
    "create",
    CALENDAR_ID,
    "--summary",
    title,
    "--from",
    slot.start.toISOString(),
    "--to",
    slot.end.toISOString(),
    "--description",
    trelloUrl ? `${title}\nTrello: ${trelloUrl}` : title,
    "--account",
    GOG_ACCOUNT,
    "--no-input",
    "--send-updates",
    "none",
    "--json",
  ]);
  return eventHtmlLink(output);
}

function fetchCalendarEvents(from, to) {
  try {
    const output = gog([
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
    ]);
    return JSON.parse(output).events || [];
  } catch {
    return [];
  }
}

function buildRoutineChecklist() {
  const lines = [
    "Complete this routine during the scheduled block.",
  ];
  return [buildNextStepsChecklist(lines)];
}

function descHasTags(desc, habitId, period) {
  const tags = parseRoutineTags(desc);
  return tags.routineId === habitId && tags.routinePeriod === period;
}

function findExistingRoutineCard(openCards, habitId, period, title) {
  return (
    openCards.find((card) => descHasTags(card.desc, habitId, period)) ||
    openCards.find((card) => String(card?.name || "").trim() === title) ||
    null
  );
}

function evTime(ev, which) {
  const value = ev?.[which];
  if (typeof value === "string") return new Date(value).getTime();
  if (value?.dateTime) return new Date(value.dateTime).getTime();
  return new Date(value?.date || 0).getTime();
}

function isWorkEvent(ev) {
  return /^work$/i.test(String(ev?.summary || "").trim());
}

async function claimPreferWindow({ card, events, slot, openCards, log }) {
  const startMs = slot.start.getTime();
  const endMs = slot.end.getTime();

  for (const event of events) {
    if (isWorkEvent(event)) continue;
    if (evTime(event, "start") >= endMs || evTime(event, "end") <= startMs) continue;

    const other = eventToTrelloCard(event, openCards);
    if (other && other.id === card?.id) continue;
    if (other && String(other.listName || "").toLowerCase() === "routine") {
      log.push({ action: "skip_routine_overlap", event: event.summary });
      continue;
    }
    if (other && ["scheduled", "reschedule"].includes(String(other.listName || "").toLowerCase())) {
      await updateOrMoveClaimedCard(other.id, log, other.name);
    }
  }
}

async function updateOrMoveClaimedCard(cardId, log, cardName) {
  await moveCard(cardId, "Reschedule", undefined, AGENT_ID);
  log.push({ action: "displaced", card: cardName, to: "Reschedule" });
}

function needsGatewayOpenCards(filePath) {
  return !filePath && Boolean(process.env.TRELLO_GATEWAY_URL);
}

async function main() {
  const manifestPath = argValue("--manifest") || DEFAULT_MANIFEST_PATH;
  const eventsPath = argValue("--events-file");
  const openCardsPath = argValue("--open-cards-file");
  const dryRun = process.argv.includes("--dry-run");
  const lookaheadDays = Number(argValue("--lookahead-days") || 14);
  const todayArg = argValue("--today");

  const manifest = loadJson(manifestPath);
  const openCards = openCardsPath
    ? loadJson(openCardsPath)
    : needsGatewayOpenCards(openCardsPath)
      ? await boardOpenCards(AGENT_ID)
      : [];
  const report = { dryRun, created: [], skipped: [] };
  const startDate = todayArg ? new Date(`${todayArg}T12:00:00-06:00`) : new Date();
  const events = eventsPath
    ? loadJson(eventsPath)
    : fetchCalendarEvents(
        new Date(startDate.getTime() - 2 * 86400_000).toISOString(),
        new Date(startDate.getTime() + (lookaheadDays + 2) * 86400_000).toISOString(),
      );

  for (const habit of manifest.routines || []) {
    for (let offset = 0; offset < lookaheadDays; offset++) {
      const date = new Date(startDate.getTime() + offset * 86400_000);
      if (!habitApplies(habit, date)) continue;

      const period = mtDateStr(date);
      const title = habit.title_template.replace("{date}", period);
      const existing = findExistingRoutineCard(openCards, habit.id, period, title);
      if (existing) {
        report.skipped.push({
          habit: habit.id,
          period,
          title,
          reason: "existing_open_card",
          cardId: existing.id || null,
          matchedBy: descHasTags(existing.desc, habit.id, period) ? "routine_tags" : "exact_title",
        });
        continue;
      }
      const slot = findRoutinePreferSlot({
        instanceDate: period,
        preferStart: habit.prefer_start,
        preferEnd: habit.prefer_end,
        durationMin: habit.duration_minutes,
        events,
        openCards,
      });

      if (!slot.start) {
        if (dryRun) {
          report.created.push({
            habit: habit.id,
            period,
            title,
            dryRun,
            manualScheduling: true,
            reason: slot.reason,
          });
          continue;
        }

        const created = await createCard(
          title,
          {
            listName: habit.trello_list || "Routine",
            desc: buildCardDescription(habit, period),
            checklists: buildRoutineChecklist(),
          },
          AGENT_ID,
        );
        await styleCard(created.cardId, AGENT_ID);
        await comment(
          created.cardId,
          buildNoSlotComment({
            title,
            preferStart: habit.prefer_start,
            preferEnd: habit.prefer_end,
          }),
          AGENT_ID,
        );
        report.created.push({
          habit: habit.id,
          period,
          cardId: created.cardId,
          title,
          manualScheduling: true,
          reason: slot.reason,
        });
        continue;
      }

      if (dryRun) {
        report.created.push({
          habit: habit.id,
          period,
          title,
          shifted: slot.shifted,
          due: slot.end.toISOString(),
          dryRun,
        });
        continue;
      }

      const calendarTime = formatCalendarTimeRange(slot.start, slot.end);
      const due = slot.end.toISOString();
      const created = await createCard(
        title,
        {
          listName: habit.trello_list || "Routine",
          desc: buildCardDescription(habit, period),
          checklists: buildRoutineChecklist(),
          due,
        },
        AGENT_ID,
      );
      await styleCard(created.cardId, AGENT_ID);
      const card = (await getCard(created.cardId, AGENT_ID)) || { id: created.cardId };
      const calendarLink = createCalendarEvent(title, slot, card.shortUrl);
      await updateCard(
        created.cardId,
        {
          desc: buildCardDescription(habit, period, calendarLink, calendarTime),
        },
        AGENT_ID,
      );
      const finalCard = {
        ...card,
        id: created.cardId,
        desc: buildCardDescription(habit, period, calendarLink, calendarTime),
        listName: habit.trello_list || "Routine",
      };
      const claimLog = [];
      await claimPreferWindow({ card: finalCard, events, slot, openCards, log: claimLog });
      openCards.push(finalCard);
      const trelloUrl = created.url || card.shortUrl || "";
      events.push({
        summary: title,
        description: trelloUrl ? `${title}\nTrello: ${trelloUrl}` : title,
        htmlLink: calendarLink,
        start: { dateTime: slot.start.toISOString() },
        end: { dateTime: slot.end.toISOString() },
      });
      report.created.push({
        habit: habit.id,
        period,
        cardId: created.cardId,
        title,
        due,
        claimLog,
        shifted: slot.shifted,
      });
    }
  }

  console.log(JSON.stringify(report));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
