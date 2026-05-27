#!/usr/bin/env node
/**
 * One-time: backfill calendar link/time into card description.
 * Skips Done, archived, and Missed lists.
 *
 * Usage:
 *   node scripts/manual/backfill_calendar_links_to_description.mjs [--dry-run]
 */
import fs from "node:fs";

import { fetchEvents, findAllLinkedEvents } from "../../trello-pipeline/calendar_lookup.mjs";
import { planDescriptionBackfill } from "./backfill_calendar_links_to_description_logic.mjs";

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
const dryRun = process.argv.includes("--dry-run");
if (!key || !token) throw new Error("Missing TRELLO_API_KEY/TRELLO_API_TOKEN");

const SKIP_LISTS = new Set(["done", "missed"]);

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

async function main() {
  const fields = await trello("GET", `boards/${board}/customFields`);
  const linkField = fields.find((field) => (field.name || "").toLowerCase() === "calendar link");
  const timeField = fields.find((field) => (field.name || "").toLowerCase() === "time needed");

  const lists = await trello("GET", `boards/${board}/lists?cards=open&card_fields=id,name,desc,closed,idList&cards_customFieldItems=true`);
  const report = { dryRun, updated: [], skipped: [], issues: [] };
  let allEvents = [];
  try {
    allEvents = fetchEvents();
  } catch (error) {
    report.issues.push({ reason: "calendar_fetch_failed", error: error.message });
  }

  for (const list of lists) {
    if (SKIP_LISTS.has(list.name.toLowerCase())) continue;
    for (const card of list.cards || []) {
      if (card.closed) continue;
      const items = card.customFieldItems || [];
      const linkItem = linkField ? items.find((item) => item.idCustomField === linkField.id) : null;
      const timeItem = timeField ? items.find((item) => item.idCustomField === timeField.id) : null;
      const cfLink = linkItem?.value?.text?.trim() || "";
      let cfTime = null;
      if (timeItem?.value?.number != null) cfTime = Math.round(Number(timeItem.value.number));
      else if (timeItem?.value?.text) {
        const parsed = parseInt(timeItem.value.text, 10);
        if (!Number.isNaN(parsed)) cfTime = parsed;
      }

      const matchedEvents = allEvents.length ? findAllLinkedEvents(card, allEvents) : [];
      const decision = planDescriptionBackfill(card, { cfLink, cfTime, matchedEvents });

      if (decision.action === "skip") {
        if (decision.reason !== "no_calendar_data") {
          report.skipped.push({
            card: card.name,
            list: list.name,
            reason: decision.reason,
            source: decision.linkSource || null,
          });
        }
        continue;
      }

      if (decision.action === "issue") {
        report.issues.push({
          card: card.name,
          list: list.name,
          reason: decision.reason,
          matchedEvents: decision.matchedEvents ?? matchedEvents.length,
        });
        continue;
      }

      if (!dryRun) await trello("PUT", `cards/${card.id}`, { desc: decision.newDesc });
      report.updated.push({
        card: card.name,
        list: list.name,
        source: decision.linkSource || null,
        viaCalendarFallback: Boolean(decision.usedCalendarFallback),
      });
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
