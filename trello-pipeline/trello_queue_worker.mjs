#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.TRELLO_PIPELINE_STATE_DIR || "/var/lib/trello-pipeline";
const MAX_HANDLER_ATTEMPTS = Number(process.env.TRELLO_PIPELINE_MAX_HANDLER_ATTEMPTS || 5);
const POLL_MS = Number(process.env.TRELLO_PIPELINE_POLL_MS || 30_000);
const ONE_SHOT = process.env.TRELLO_PIPELINE_ONE_SHOT === "1";

fs.mkdirSync(STATE, { recursive: true });

if (!process.env.TRELLO_GATEWAY_URL) throw new Error("TRELLO_GATEWAY_URL is required");
const GATEWAY_URL = process.env.TRELLO_GATEWAY_URL;
const GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY;
if (!GATEWAY_KEY) throw new Error("Missing TRELLO_GATEWAY_KEY");

const pendingFile = path.join(STATE, "actionable_pending.jsonl");
const handledFile = path.join(STATE, "actionable_handled_ids.json");
const failuresFile = path.join(STATE, "handler_failures.json");
const logFile = path.join(STATE, "queue_worker.log");

function log(msg, obj) {
  fs.appendFileSync(logFile, `${new Date().toISOString()} ${msg}${obj ? ` ${JSON.stringify(obj)}` : ""}\n`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function entries() {
  if (!fs.existsSync(pendingFile)) return [];
  return fs
    .readFileSync(pendingFile, "utf8")
    .split(/\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function failureRecord(actionId) {
  const failures = readJson(failuresFile, {});
  return failures[actionId] || null;
}

function recordFailure(actionId, detail) {
  const failures = readJson(failuresFile, {});
  const previous = failures[actionId] || { count: 0 };
  failures[actionId] = { count: previous.count + 1, lastAt: new Date().toISOString(), ...detail };
  const keys = Object.keys(failures);
  if (keys.length > 500) {
    for (const key of keys.slice(0, keys.length - 500)) delete failures[key];
  }
  writeJson(failuresFile, failures);
}

function clearFailure(actionId) {
  const failures = readJson(failuresFile, {});
  if (failures[actionId]) {
    delete failures[actionId];
    writeJson(failuresFile, failures);
  }
}

async function runHandler(handler, args) {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    let stderr = "";
    const child = spawn(process.execPath, [handler, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    const timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {}
      resolve({ ok: false, code: null, signal: "timeout", stderr: stderr.trim() });
    }, 120_000);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, signal: signal || null, stderr: stderr.trim() });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: "spawn_error", stderr: error.message });
    });
  });
}

function markHandled(id) {
  const handled = new Set(readJson(handledFile, []));
  handled.add(id);
  writeJson(handledFile, [...handled].slice(-3000));
}

async function runDeterministicHandler(entry, handlerPath, args, eventName) {
  const previous = failureRecord(entry.actionId);
  const attempt = (previous?.count || 0) + 1;

  if (previous && previous.count >= MAX_HANDLER_ATTEMPTS) {
    markHandled(entry.actionId);
    log(`${eventName}_gave_up`, {
      actionId: entry.actionId,
      attempts: previous.count,
      lastExitCode: previous.exitCode,
      lastStderr: (previous.stderr || "").slice(0, 200),
    });
    return true;
  }

  const result = await runHandler(handlerPath, args);
  if (result.ok) {
    clearFailure(entry.actionId);
    markHandled(entry.actionId);
    log(`handled_${eventName}`, { actionId: entry.actionId, card: entry.cardName || entry.cardId });
    return true;
  }

  recordFailure(entry.actionId, {
    exitCode: result.code,
    signal: result.signal,
    stderr: result.stderr,
    handler: path.basename(handlerPath),
  });
  log(`${eventName}_failed`, {
    actionId: entry.actionId,
    card: entry.cardName,
    attempt,
    maxAttempts: MAX_HANDLER_ATTEMPTS,
    exitCode: result.code,
    signal: result.signal,
    stderr: result.stderr.slice(0, 400),
  });
  return true;
}

async function gateway(operation, cardId, params = {}) {
  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify({ agentId: "system", operation, cardId, params }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(`Gateway ${operation} HTTP ${response.status}: ${text.slice(0, 300)}`);
  return data;
}

async function getCard(cardId) {
  const data = await gateway("get", cardId);
  return data.card || null;
}

function handlerPath(kind) {
  if (kind === "trello_card_moved_to_reschedule") {
    return process.env.TRELLO_PIPELINE_RESCHEDULE_HANDLER || path.join(__dirname, "handle_reschedule.mjs");
  }
  if (kind === "trello_card_moved_to_missed") {
    return process.env.TRELLO_PIPELINE_MISSED_HANDLER || path.join(__dirname, "trello_missed_adjust_calendar.mjs");
  }
  if (kind === "trello_card_moved_to_done") {
    return process.env.TRELLO_PIPELINE_DONE_HANDLER || path.join(__dirname, "trello_done_adjust_calendar.mjs");
  }
  return null;
}

async function handle(entry) {
  const card = entry.cardId ? await getCard(entry.cardId).catch(() => null) : null;
  if (card?.closed) {
    log("skipped_closed_card", { actionId: entry.actionId, cardId: card.id, cardName: card.name });
    markHandled(entry.actionId);
    return true;
  }

  if (entry.kind === "trello_card_moved_to_reschedule" && card) {
    return runDeterministicHandler(
      entry,
      handlerPath(entry.kind),
      ["--card-id", card.id, "--short-link", card.shortUrl || card.shortLink, "--from-list", entry.fromListName || "unknown"],
      "reschedule",
    );
  }

  if (entry.kind === "trello_card_moved_to_missed" && card) {
    return runDeterministicHandler(entry, handlerPath(entry.kind), [card.shortLink || card.id], "missed");
  }

  if (entry.kind === "trello_card_moved_to_done" && card) {
    return runDeterministicHandler(entry, handlerPath(entry.kind), [card.shortLink || card.id], "done");
  }

  markHandled(entry.actionId);
  log("delegated_or_silent", { actionId: entry.actionId, kind: entry.kind, card: entry.cardName });
  return true;
}

function reschedulePriorityRank(cardName) {
  const title = String(cardName || "").toUpperCase();
  if (/\bP3\b/.test(title)) return 3;
  if (/\bP2\b/.test(title)) return 2;
  if (/\bP1\b/.test(title)) return 1;
  return 2;
}

function pendingQueueOrder(a, b) {
  const aReschedule = a.kind === "trello_card_moved_to_reschedule";
  const bReschedule = b.kind === "trello_card_moved_to_reschedule";
  if (aReschedule !== bReschedule) return aReschedule ? -1 : 1;
  if (aReschedule && bReschedule) return reschedulePriorityRank(b.cardName) - reschedulePriorityRank(a.cardName);
  return 0;
}

async function tick() {
  const handled = new Set(readJson(handledFile, []));
  const pending = entries().filter((entry) => entry?.actionId && !handled.has(entry.actionId));
  pending.sort(pendingQueueOrder);
  for (const entry of pending) {
    try {
      await handle(entry);
    } catch (error) {
      log("handle_error", { actionId: entry.actionId, message: error.message });
    }
    return pending.length > 0;
  }
  return false;
}

async function main() {
  log("started");
  if (ONE_SHOT) {
    await tick();
    return;
  }

  while (true) {
    await tick();
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

main().catch((error) => {
  log("fatal", { message: error.message });
  process.exit(1);
});
