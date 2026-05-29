#!/usr/bin/env node
/**
 * One-time: set Routine card due dates to the linked calendar block end.
 *
 * Usage:
 *   node scripts/manual/backfill_routine_card_due.mjs [--dry-run]
 *
 * Requires TRELLO_API_KEY/TRELLO_API_TOKEN (or trello_bridge .env).
 * Uses TRELLO_GATEWAY_URL + TRELLO_GATEWAY_KEY for writes when configured.
 *
 * Calendar is required: if gog cannot load events, the script exits immediately
 * (no Trello reads/writes). Fix GOG_BIN / GOG_ACCOUNT / calendar access first.
 */
import fs from "node:fs";

import { fetchEvents, findAllLinkedEvents } from "../../trello-pipeline/calendar_lookup.mjs";
import { loadCalendarEventsRequired, planRoutineDueBackfill } from "./backfill_routine_card_due_logic.mjs";

const bridgeEnv = process.env.TRELLO_BRIDGE_ENV || "/home/node/.openclaw/workspace/trello_bridge/.env";
if (fs.existsSync(bridgeEnv)) {
  for (const line of fs.readFileSync(bridgeEnv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const key = process.env.TRELLO_API_KEY;
const token = process.env.TRELLO_API_TOKEN;
const board = process.env.TRELLO_BOARD_ID || "69f96aafc342ad1c89f48e0c";
const gatewayUrl = process.env.TRELLO_GATEWAY_URL || "";
const gatewayKey = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY || "";
const dryRun = process.argv.includes("--dry-run");
const AGENT_ID = "system";

if (!key || !token) throw new Error("Missing TRELLO_API_KEY/TRELLO_API_TOKEN");

async function trello(method, path, body) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(
    `https://api.trello.com/1/${path}${separator}key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`,
    {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function setCardDue(cardId, due) {
  if (gatewayUrl && gatewayKey) {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        agentId: AGENT_ID,
        operation: "update",
        cardId,
        params: { fields: { due } },
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`gateway update: ${response.status} ${text}`);
    return text ? JSON.parse(text) : {};
  }

  return trello("PUT", `cards/${cardId}`, { due });
}

function fatalCalendarFetch(error) {
  const payload = {
    event: "calendar_fetch_failed",
    fatal: true,
    calendarId: process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com",
    gogAccount: process.env.GOG_ACCOUNT || "ubitheai@gmail.com",
    gogBin: process.env.GOG_BIN || "gog",
    message: error?.message || String(error),
  };
  console.error("FATAL: routine due backfill requires a working calendar fetch.");
  console.error(JSON.stringify(payload, null, 2));
  process.exit(1);
}

async function main() {
  let allEvents;
  try {
    allEvents = loadCalendarEventsRequired(fetchEvents);
  } catch (error) {
    fatalCalendarFetch(error);
    return;
  }

  console.error(
    JSON.stringify({
      event: "calendar_fetch_ok",
      eventCount: allEvents.length,
      dryRun,
    }),
  );

  const lists = await trello(
    "GET",
    `boards/${board}/lists?cards=open&card_fields=id,name,desc,closed,idList,due,shortUrl,shortLink`,
  );
  const report = { dryRun, calendarEventCount: allEvents.length, updated: [], skipped: [], issues: [] };

  for (const list of lists) {
    if (list.name.toLowerCase() !== "routine") continue;

    for (const card of list.cards || []) {
      const enriched = { ...card, listName: list.name };
      const matchedEvents = findAllLinkedEvents(enriched, allEvents);
      const decision = planRoutineDueBackfill(enriched, { matchedEvents });

      if (decision.action === "skip") {
        if (decision.reason !== "no_calendar_end") {
          report.skipped.push({
            card: card.name,
            cardId: card.id,
            reason: decision.reason,
            expectedDue: decision.expectedDue || null,
            dueSource: decision.dueSource || null,
          });
        }
        continue;
      }

      if (decision.action === "issue") {
        report.issues.push({
          card: card.name,
          cardId: card.id,
          reason: decision.reason,
          matchedEvents: decision.matchedEvents ?? matchedEvents.length,
        });
        continue;
      }

      if (!dryRun) await setCardDue(card.id, decision.due);
      report.updated.push({
        card: card.name,
        cardId: card.id,
        due: decision.due,
        dueSource: decision.dueSource,
        previousDue: decision.previousDue,
      });
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
