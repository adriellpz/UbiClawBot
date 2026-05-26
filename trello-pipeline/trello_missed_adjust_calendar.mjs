#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { findAllLinkedEvents, fetchEvents } from "./calendar_lookup.mjs";
import { parseCalendarLink } from "./trello_card_calendar_desc.mjs";

if (!process.env.TRELLO_GATEWAY_URL) throw new Error("TRELLO_GATEWAY_URL is required");
const GATEWAY_URL = process.env.TRELLO_GATEWAY_URL;
const GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;
if (!GATEWAY_KEY) throw new Error("Missing TRELLO_GATEWAY_KEY");

function normalizeCardRef(ref) {
  const match = String(ref || "").match(/trello\.com\/c\/([a-zA-Z0-9]+)/);
  return match ? match[1] : ref;
}

const cardRef = normalizeCardRef(process.argv[2]);
if (!cardRef) throw new Error("Usage: trello_missed_adjust_calendar.mjs <cardShortLinkOrId>");

async function gw(operation, cardId, params = {}) {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify({ agentId: "system", operation, cardId, params }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Gateway ${operation}: ${response.status} ${text.slice(0, 300)}`);
  return data;
}

function gogEnv() {
  const env = { ...process.env };
  const gogBin = process.env.GOG_BIN || "gog";
  if (gogBin.includes("/")) env.PATH = `${path.dirname(gogBin)}:${env.PATH || ""}`;
  const passwordFile = process.env.GOG_KEYRING_PASSWORD_FILE || "/home/node/.openclaw/credentials/gog-keyring-password";
  if (!env.GOG_KEYRING_PASSWORD) {
    try {
      env.GOG_KEYRING_PASSWORD = fs.readFileSync(passwordFile, "utf8").trim();
    } catch {}
  }
  return env;
}

function gog(args) {
  return execFileSync(process.env.GOG_BIN || "gog", args, {
    encoding: "utf8",
    env: gogEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const card = (await gw("get", cardRef)).card || null;
if (!card) {
  console.log(JSON.stringify({ deleted: false, reason: "card_not_found" }));
  process.exit(0);
}
if (card.closed) {
  console.log(JSON.stringify({ deleted: false, skipped: "card_is_closed_archived", cardId: card.id, cardName: card.name }));
  process.exit(0);
}

const allEvents = fetchEvents();
const matches = findAllLinkedEvents(card, allEvents);
if (!matches.length) {
  console.log(JSON.stringify({ deleted: false, reason: "no_matching_calendar_event", card: card.name, cardUrl: card.shortUrl, hasCalendarLink: !!parseCalendarLink(card.desc) }));
  process.exit(0);
}

let deleted = 0;
for (const event of matches) {
  gog(["calendar", "delete", process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com", event.id, "--account", process.env.GOG_ACCOUNT || "ubitheai@gmail.com", "--no-input", "--force", "--send-updates", "none"]);
  deleted += 1;
}

await gw("comment", card.id, { text: `Missed cleanup: deleted ${deleted} calendar event(s) for this card. @adriellopez1` });
console.log(JSON.stringify({ deleted: true, count: deleted, card: card.name, cardUrl: card.shortUrl }));
