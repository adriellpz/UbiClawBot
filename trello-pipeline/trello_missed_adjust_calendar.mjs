#!/usr/bin/env node
import process from "node:process";

import { findAllLinkedEvents, fetchEvents } from "./calendar_lookup.mjs";
import { makeGw, makeGog } from "./pipeline_helpers.mjs";
import { parseCalendarLink } from "./trello_card_calendar_desc.mjs";

function normalizeCardRef(ref) {
  const match = String(ref || "").match(/trello\.com\/c\/([a-zA-Z0-9]+)/);
  return match ? match[1] : ref;
}

export async function run(card, _ctx = {}) {
  const gatewayUrl = process.env.TRELLO_GATEWAY_URL;
  const gatewayKey = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;
  if (!gatewayUrl) throw new Error("TRELLO_GATEWAY_URL is required");
  if (!gatewayKey) throw new Error("Missing TRELLO_GATEWAY_KEY");

  const gw = makeGw(gatewayUrl, gatewayKey);
  const gog = makeGog();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com";
  const gogAccount = process.env.GOG_ACCOUNT || "ubitheai@gmail.com";

  if (!card) return { ok: false, reason: "card_not_found" };
  if (card.closed) return { ok: true, skipped: "card_is_closed_archived" };

  const allEvents = fetchEvents();
  const matches = findAllLinkedEvents(card, allEvents);
  if (!matches.length) {
    return { ok: true, deleted: false, reason: "no_matching_calendar_event", card: card.name, hasCalendarLink: !!parseCalendarLink(card.desc) };
  }

  let deleted = 0;
  for (const event of matches) {
    gog(["calendar", "delete", calendarId, event.id, "--account", gogAccount, "--no-input", "--force", "--send-updates", "none"]);
    deleted += 1;
  }

  await gw("comment", card.id, { text: `Missed cleanup: deleted ${deleted} calendar event(s) for this card. @adriellopez1` });
  return { ok: true, deleted: true, count: deleted, card: card.name, cardUrl: card.shortUrl };
}

// CLI entry point
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const cardRef = normalizeCardRef(process.argv[2]);
  if (!cardRef) throw new Error("Usage: trello_missed_adjust_calendar.mjs <cardShortLinkOrId>");

  const gatewayUrl = process.env.TRELLO_GATEWAY_URL;
  const gatewayKey = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;
  if (!gatewayUrl) throw new Error("TRELLO_GATEWAY_URL is required");
  if (!gatewayKey) throw new Error("Missing TRELLO_GATEWAY_KEY");

  const gw = makeGw(gatewayUrl, gatewayKey);
  const card = (await gw("get", cardRef)).card || null;
  const result = await run(card);
  console.log(JSON.stringify(result));
}
