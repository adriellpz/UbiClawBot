#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { findLinkedEvent, fetchEvents } from "./calendar_lookup.mjs";
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
const completedAt = process.argv[3] ? new Date(process.argv[3]) : new Date();
if (!cardRef) throw new Error("Usage: trello_done_adjust_calendar.mjs <cardShortLinkOrId> [completedAtIso]");
if (Number.isNaN(completedAt.getTime())) throw new Error(`Invalid completedAt: ${process.argv[3]}`);

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

async function getCard(ref) {
  const data = await gw("get", ref);
  return data.card || null;
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

function withOffsetLike(local, date) {
  const match = String(local).match(/([+-]\d\d:\d\d|Z)$/);
  const offset = match ? match[1] : "-06:00";
  const pad = (value) => String(value).padStart(2, "0");
  const offsetMinutes = offset === "Z" ? 0 : (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6))) * (offset[0] === "-" ? -1 : 1);
  const shifted = new Date(date.getTime() + offsetMinutes * 60000);
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}T${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:00${offset}`;
}

function ceilToNextFive(date) {
  const value = new Date(date);
  value.setSeconds(0, 0);
  const remainder = value.getMinutes() % 5;
  if (remainder) value.setMinutes(value.getMinutes() + (5 - remainder));
  return value;
}

function eventDate(value, localFallback) {
  if (typeof value === "string") return new Date(value);
  if (value?.dateTime) return new Date(value.dateTime);
  if (value?.date) return new Date(value.date);
  return new Date(localFallback);
}

const card = await getCard(cardRef);
if (card.closed) {
  console.log(JSON.stringify({ adjusted: false, skipped: "card_is_closed_archived", cardId: card.id, cardName: card.name }));
  process.exit(0);
}

const reviewDue = new Date(Date.now() + 24 * 3600_000).toISOString();
await gw("update", card.id, { fields: { due: reviewDue } });

const allEvents = fetchEvents();
const event = findLinkedEvent(card, allEvents);
if (!event) {
  console.log(JSON.stringify({ adjusted: false, reason: "no_matching_calendar_event", card: card.name, cardUrl: card.shortUrl, hasCalendarLink: !!parseCalendarLink(card.desc) }));
  process.exit(0);
}

const start = eventDate(event.start, event.startLocal);
const end = eventDate(event.end, event.endLocal);
const newEnd = ceilToNextFive(completedAt);

if (newEnd.getTime() >= end.getTime()) {
  console.log(JSON.stringify({ adjusted: false, reason: "completion_not_before_event_end", card: card.name, eventId: event.id, oldEnd: event.endLocal, completedAt: completedAt.toISOString() }));
  process.exit(0);
}

if (newEnd.getTime() <= start.getTime()) {
  gog(["calendar", "delete", process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com", event.id, "--account", process.env.GOG_ACCOUNT || "ubitheai@gmail.com", "--no-input", "--force", "--send-updates", "none"]);
  await gw("comment", card.id, {
    text: `Done-time cleanup: deleted calendar event (completed at ${completedAt.toISOString()}, before scheduled start ${event.startLocal || event.start}). Work was done ahead of the block. @adriellopez1`,
  });
  console.log(JSON.stringify({ adjusted: true, action: "deleted", card: card.name, cardUrl: card.shortUrl, eventId: event.id, reason: "completed_before_event_start", completedAt: completedAt.toISOString(), eventStart: event.startLocal || event.start }));
  process.exit(0);
}

const newEndLocal = withOffsetLike(event.endLocal || event.end, newEnd);
gog(["calendar", "update", process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com", event.id, "--account", process.env.GOG_ACCOUNT || "ubitheai@gmail.com", "--no-input", "--force", "--to", newEndLocal, "--send-updates", "none"]);
await gw("comment", card.id, {
  text: `Done-time calendar trim: shortened the calendar event to end at ${newEndLocal}, the next 5-minute mark after completion, to free the remaining time for priority bump/gap-fill analysis. @adriellopez1`,
});
console.log(JSON.stringify({ adjusted: true, card: card.name, cardUrl: card.shortUrl, eventId: event.id, oldEnd: event.endLocal || event.end, newEnd: newEndLocal }));
