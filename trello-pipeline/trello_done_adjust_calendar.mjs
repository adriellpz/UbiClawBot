#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { findLinkedEvent, fetchEvents } from "./calendar_lookup.mjs";
import { parseCalendarLink } from "./trello_card_calendar_desc.mjs";

function normalizeCardRef(ref) {
  const match = String(ref || "").match(/trello\.com\/c\/([a-zA-Z0-9]+)/);
  return match ? match[1] : ref;
}

function makeGw(gatewayUrl, gatewayKey) {
  return async function gw(operation, cardId, params = {}) {
    const response = await fetch(gatewayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${gatewayKey}` },
      body: JSON.stringify({ agentId: "system", operation, cardId, params }),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(`Gateway ${operation}: ${response.status} ${text.slice(0, 300)}`);
    return data;
  };
}

function makeGog() {
  return function gog(args) {
    const gogBin = process.env.GOG_BIN || "gog";
    const env = { ...process.env };
    if (gogBin.includes("/")) env.PATH = `${path.dirname(gogBin)}:${env.PATH || ""}`;
    const passwordFile = process.env.GOG_KEYRING_PASSWORD_FILE || "/home/node/.openclaw/credentials/gog-keyring-password";
    if (!env.GOG_KEYRING_PASSWORD) {
      try { env.GOG_KEYRING_PASSWORD = fs.readFileSync(passwordFile, "utf8").trim(); } catch {}
    }
    return execFileSync(gogBin, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  };
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

export async function run(card, ctx = {}) {
  const gatewayUrl = process.env.TRELLO_GATEWAY_URL;
  const gatewayKey = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;
  if (!gatewayUrl) throw new Error("TRELLO_GATEWAY_URL is required");
  if (!gatewayKey) throw new Error("Missing TRELLO_GATEWAY_KEY");

  const gw = makeGw(gatewayUrl, gatewayKey);
  const gog = makeGog();
  const calendarId = process.env.GOOGLE_CALENDAR_ID || "adriellpz@gmail.com";
  const gogAccount = process.env.GOG_ACCOUNT || "ubitheai@gmail.com";
  const completedAt = ctx.completedAt ? new Date(ctx.completedAt) : new Date();

  if (card.closed) return { ok: true, adjusted: false, skipped: "card_is_closed_archived" };

  const reviewDue = new Date(Date.now() + 24 * 3600_000).toISOString();
  await gw("update", card.id, { fields: { due: reviewDue } });

  const allEvents = fetchEvents();
  const event = findLinkedEvent(card, allEvents);
  if (!event) {
    return { ok: true, adjusted: false, reason: "no_matching_calendar_event", card: card.name, hasCalendarLink: !!parseCalendarLink(card.desc) };
  }

  const start = eventDate(event.start, event.startLocal);
  const end = eventDate(event.end, event.endLocal);
  const newEnd = ceilToNextFive(completedAt);

  if (newEnd.getTime() >= end.getTime()) {
    return { ok: true, adjusted: false, reason: "completion_not_before_event_end", card: card.name, eventId: event.id };
  }

  if (newEnd.getTime() <= start.getTime()) {
    gog(["calendar", "delete", calendarId, event.id, "--account", gogAccount, "--no-input", "--force", "--send-updates", "none"]);
    await gw("comment", card.id, {
      text: `Done-time cleanup: deleted calendar event (completed at ${completedAt.toISOString()}, before scheduled start ${event.startLocal || event.start}). Work was done ahead of the block. @adriellopez1`,
    });
    return { ok: true, adjusted: true, action: "deleted", card: card.name, eventId: event.id, reason: "completed_before_event_start" };
  }

  const newEndLocal = withOffsetLike(event.endLocal || event.end, newEnd);
  gog(["calendar", "update", calendarId, event.id, "--account", gogAccount, "--no-input", "--force", "--to", newEndLocal, "--send-updates", "none"]);
  await gw("comment", card.id, {
    text: `Done-time calendar trim: shortened the calendar event to end at ${newEndLocal}, the next 5-minute mark after completion, to free the remaining time for priority bump/gap-fill analysis. @adriellopez1`,
  });
  return { ok: true, adjusted: true, card: card.name, eventId: event.id, oldEnd: event.endLocal || event.end, newEnd: newEndLocal };
}

// CLI entry point
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const cardRef = normalizeCardRef(process.argv[2]);
  const completedAt = process.argv[3] ? new Date(process.argv[3]) : new Date();
  if (!cardRef) throw new Error("Usage: trello_done_adjust_calendar.mjs <cardShortLinkOrId> [completedAtIso]");
  if (Number.isNaN(completedAt.getTime())) throw new Error(`Invalid completedAt: ${process.argv[3]}`);

  const gatewayUrl = process.env.TRELLO_GATEWAY_URL;
  const gatewayKey = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;
  if (!gatewayUrl) throw new Error("TRELLO_GATEWAY_URL is required");
  if (!gatewayKey) throw new Error("Missing TRELLO_GATEWAY_KEY");

  const gw = makeGw(gatewayUrl, gatewayKey);
  const card = (await gw("get", cardRef)).card || null;
  if (!card) {
    console.log(JSON.stringify({ adjusted: false, skipped: "card_is_closed_archived", reason: "card_not_found" }));
    process.exit(0);
  }
  const result = await run(card, { completedAt: completedAt.toISOString() });
  console.log(JSON.stringify(result));
}
