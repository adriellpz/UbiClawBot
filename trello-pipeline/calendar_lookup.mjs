import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { parseCalendarLink } from "./trello_card_calendar_desc.mjs";

const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com";
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "ubitheai@gmail.com";

export function getCalendarLink(card) {
  return parseCalendarLink(card.desc || "");
}

function extractEid(htmlLink) {
  try {
    const url = new URL(htmlLink);
    return url.searchParams.get("eid") || "";
  } catch {
    return "";
  }
}

function matchesByTrelloUrl(event, card) {
  const cardUrl = card.shortUrl || "";
  const shortLink = card.shortLink || "";
  const description = event.description || "";
  return (cardUrl && description.includes(cardUrl)) || (shortLink && description.includes(shortLink));
}

function matchesByEid(event, eid) {
  if (!eid) return false;
  return String(event.htmlLink || "").includes(eid);
}

export function findLinkedEvent(card, events) {
  const allEvents = events || fetchEvents();
  const calendarLink = getCalendarLink(card);
  if (calendarLink) {
    const eid = extractEid(calendarLink);
    if (eid) {
      const match = allEvents.find((event) => matchesByEid(event, eid));
      if (match) return match;
    }
  }
  return allEvents.find((event) => matchesByTrelloUrl(event, card)) || null;
}

export function findAllLinkedEvents(card, events) {
  const allEvents = events || fetchEvents();
  const seen = new Set();
  const out = [];

  const calendarLink = getCalendarLink(card);
  if (calendarLink) {
    const eid = extractEid(calendarLink);
    for (const event of allEvents) {
      if (eid && matchesByEid(event, eid) && !seen.has(event.id)) {
        seen.add(event.id);
        out.push(event);
      }
    }
  }

  for (const event of allEvents) {
    if (matchesByTrelloUrl(event, card) && !seen.has(event.id)) {
      seen.add(event.id);
      out.push(event);
    }
  }

  return out;
}

export function fetchEvents() {
  const env = gogEnv();
  const from = new Date(Date.now() - 90 * 86400_000).toISOString();
  const to = new Date(Date.now() + 90 * 86400_000).toISOString();
  const gogBin = process.env.GOG_BIN || "gog";
  const raw = execFileSync(
    gogBin,
    ["calendar", "events", CALENDAR_ID, "--from", from, "--to", to, "--account", GOG_ACCOUNT, "--json", "--no-input", "--all-pages", "--max", "500"],
    { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
  );
  return JSON.parse(raw).events || [];
}

function gogEnv() {
  const env = { ...process.env };
  if (process.env.GOG_BIN) {
    const binDir = process.env.GOG_BIN.includes("/") ? path.dirname(process.env.GOG_BIN) : "";
    env.PATH = `${binDir}${binDir ? ":" : ""}${env.PATH || ""}`;
  }
  const passwordFile = process.env.GOG_KEYRING_PASSWORD_FILE || "/home/node/.openclaw/credentials/gog-keyring-password";
  if (!env.GOG_KEYRING_PASSWORD) {
    try {
      env.GOG_KEYRING_PASSWORD = fs.readFileSync(passwordFile, "utf8").trim();
    } catch {}
  }
  return env;
}
