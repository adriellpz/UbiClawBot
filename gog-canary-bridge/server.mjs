import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFile } from "node:child_process";

const PORT = Number(process.env.GOG_CANARY_BRIDGE_PORT || 19093);
const CHECK_MS = Number(process.env.GOG_CANARY_CHECK_MS || 300_000);
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "ubitheai@gmail.com";
const GOG_BIN = process.env.GOG_BIN || "gog";
const STATE_DIR = process.env.GOG_CANARY_STATE_DIR || "/var/lib/gog-canary-bridge";
const ALLOW_SIMULATE = process.env.GOG_CANARY_ALLOW_SIMULATE === "1";
const SKIP_SCHEDULE = process.env.GOG_CANARY_SKIP_SCHEDULE === "1";

const TRELLO_GATEWAY_URL = process.env.TRELLO_GATEWAY_URL || "";
const TRELLO_GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || "";
const TRELLO_GATEWAY_AGENT_ID = process.env.TRELLO_GATEWAY_AGENT_ID || "main";
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || "";
const TRELLO_INTAKE_LIST_ID = process.env.TRELLO_INTAKE_LIST_ID || "";
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || "";
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || "";
const OPENCLAW_HOOK_AGENT_ID = process.env.OPENCLAW_HOOK_AGENT_ID || "main";
const OPENCLAW_HOOK_SESSION_PREFIX = process.env.OPENCLAW_HOOK_SESSION_PREFIX || "hook:gog-canary:";
const DONE_LIST_NAMES = (process.env.TRELLO_DONE_LIST_NAMES || "Done")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);
const LIST_CACHE_TTL_MS = Number(process.env.TRELLO_LIST_CACHE_TTL_MS ?? 5 * 60 * 1000);
const HAS_TRELLO_GATEWAY = Boolean(TRELLO_GATEWAY_URL && TRELLO_GATEWAY_KEY);

fs.mkdirSync(STATE_DIR, { recursive: true });

const wakeDeduper = new Map();
let listNameByIdCache = null;
let listNameByIdCacheTs = 0;
let healthOk = true;
let healthInterval = null;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function appendJsonl(fileName, entry) {
  fs.appendFileSync(path.join(STATE_DIR, fileName), `${JSON.stringify(entry)}\n`);
}

function shouldWake(dedupeKey) {
  const now = Date.now();
  const previous = wakeDeduper.get(dedupeKey) || 0;
  const dedupeWindowMs = 5 * 60 * 1000;
  if (now - previous < dedupeWindowMs) return false;
  wakeDeduper.set(dedupeKey, now);
  return true;
}

function buildCardTitle(account = GOG_ACCOUNT) {
  const local = String(account || "unknown").split("@")[0] || "unknown";
  return `P1 - GOG Auth: ${local} re-auth needed`;
}

function buildCardDescription({ account, error, checkedAt }) {
  return [
    "Original Request:",
    "GOG auth health check failed — Google Calendar/Gmail access may need re-auth.",
    "",
    "Research:",
    `Account: ${account}`,
    `GOG canary account: ${account}`,
    `Error: ${error}`,
    `Checked at: ${checkedAt}`,
    "",
    "Peer Review:",
    "",
    "Work completed:",
  ].join("\n");
}

function buildWakeMessage({ account, error, checkedAt }, cardResult) {
  return [
    "gog_auth_canary_failed",
    `account: ${account}`,
    `error: ${error}`,
    `checked_at: ${checkedAt}`,
    `trello: ${cardResult.mode} ${cardResult.cardUrl}`,
    "",
    "This card came from the periodic GOG auth health canary.",
    "",
    "Step 0: Style the card (cover, priority tag).",
    "Step 1: Fill `Original Request`, `Research`, `Peer Review`, `Work completed`.",
    "Step 2: Diagnose the auth failure, re-auth or escalate to @adriellopez1 as needed. Move to Done when auth is restored.",
    "When moving to Done, comment @adriellopez1 so Adriel is notified.",
  ].join("\n");
}

async function trelloGatewayRequest(operation, { cardId, params = {} } = {}) {
  const body = { agentId: TRELLO_GATEWAY_AGENT_ID, operation, params };
  if (cardId) body.cardId = cardId;
  const res = await fetch(TRELLO_GATEWAY_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${TRELLO_GATEWAY_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`Trello gateway ${operation} returned invalid JSON: ${text.slice(0, 200)}`);
    }
  }
  if (!res.ok) {
    const detail = data?.details || data?.error || text || "unknown error";
    throw new Error(`Trello gateway ${operation} ${res.status}: ${detail}`);
  }
  return data;
}

async function getBoardLists({ includeClosed = false } = {}) {
  const data = await trelloGatewayRequest("board_lists");
  const lists = Array.isArray(data.lists) ? data.lists : [];
  return includeClosed ? lists : lists.filter((list) => !list.closed);
}

async function getBoardListNameById() {
  const now = Date.now();
  if (listNameByIdCache && now - listNameByIdCacheTs < LIST_CACHE_TTL_MS) return listNameByIdCache;
  const lists = await getBoardLists({ includeClosed: true });
  listNameByIdCache = new Map(lists.map((list) => [list.id, list.name || ""]));
  listNameByIdCacheTs = now;
  return listNameByIdCache;
}

async function getIntakeList() {
  const lists = await getBoardLists();
  if (!Array.isArray(lists) || lists.length === 0) throw new Error("No open Trello lists found on target board");
  if (!TRELLO_INTAKE_LIST_ID) return lists[0];
  const intakeList = lists.find((list) => list.id === TRELLO_INTAKE_LIST_ID);
  if (!intakeList) throw new Error(`TRELLO_INTAKE_LIST_ID ${TRELLO_INTAKE_LIST_ID} was not found on the target board`);
  return intakeList;
}

function cardUrl(shortUrl) {
  if (!shortUrl) return undefined;
  return String(shortUrl).startsWith("http") ? shortUrl : `https://trello.com/c/${shortUrl}`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cardMatchesAccount(card, account) {
  return new RegExp(`GOG canary account:\\s*${escapeRegExp(account)}\\b`).test(String(card?.desc || ""));
}

function buildCardSearchQuery(account) {
  return TRELLO_BOARD_ID
    ? `GOG canary account: ${account} board:${TRELLO_BOARD_ID}`
    : `GOG canary account: ${account}`;
}

async function findExistingOpenCard(account) {
  const data = await trelloGatewayRequest("search", { params: { query: buildCardSearchQuery(account) } });
  const cards = (Array.isArray(data.cards) ? data.cards : []).map((card) => ({
    ...card,
    url: card.url || cardUrl(card.shortUrl),
  }));
  const listNameById = await getBoardListNameById();
  return (
    cards.find((card) => {
      if (card.closed) return false;
      const listName = String(listNameById.get(card.idList) || "").trim().toLowerCase();
      if (DONE_LIST_NAMES.includes(listName)) return false;
      return cardMatchesAccount(card, account);
    }) || null
  );
}

async function upsertCanaryCard(failure) {
  const account = failure.account;
  if (!account) throw new Error("missing gog account");

  const existing = await findExistingOpenCard(account);
  if (existing) {
    return { mode: "updated", cardId: existing.id, cardUrl: existing.url };
  }

  const intakeList = await getIntakeList();
  const created = await trelloGatewayRequest("create_card", {
    params: {
      listName: intakeList.name,
      name: buildCardTitle(account),
      desc: buildCardDescription(failure),
      pos: "top",
    },
  });
  return {
    mode: "created",
    cardId: created.cardId || created.id,
    cardUrl: created.url || cardUrl(created.shortUrl),
  };
}

async function wakeOpenClaw(failure, cardResult) {
  if (!OPENCLAW_HOOK_URL || !OPENCLAW_HOOK_TOKEN) return { skipped: "openclaw_hook_not_configured" };
  const dedupeKey = `${failure.account}:${cardResult.mode}`;
  if (!shouldWake(dedupeKey)) return { skipped: "deduped_recently" };

  const body = {
    message: buildWakeMessage(failure, cardResult),
    agentId: OPENCLAW_HOOK_AGENT_ID,
    sessionKey: `${OPENCLAW_HOOK_SESSION_PREFIX}${failure.account}`,
  };

  const res = await fetch(OPENCLAW_HOOK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${OPENCLAW_HOOK_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenClaw hook ${res.status}: ${text}`);
  }
  return { ok: true };
}

function basicConfigCheck() {
  const missing = [];
  if (!HAS_TRELLO_GATEWAY) {
    if (!TRELLO_GATEWAY_URL) missing.push("TRELLO_GATEWAY_URL");
    if (!TRELLO_GATEWAY_KEY) missing.push("TRELLO_GATEWAY_KEY");
  }
  if (!TRELLO_BOARD_ID && !TRELLO_INTAKE_LIST_ID) missing.push("TRELLO_BOARD_ID or TRELLO_INTAKE_LIST_ID");
  if (!OPENCLAW_HOOK_URL) missing.push("OPENCLAW_HOOK_URL");
  if (!OPENCLAW_HOOK_TOKEN) missing.push("OPENCLAW_HOOK_TOKEN");
  return missing;
}

export async function handleAuthFailure({ account = GOG_ACCOUNT, error, checkedAt = new Date().toISOString() } = {}) {
  const missingConfig = basicConfigCheck();
  if (missingConfig.length > 0) {
    throw new Error(`missing_config: ${missingConfig.join(", ")}`);
  }

  const failure = {
    account,
    error: String(error || "unknown").slice(0, 500),
    checkedAt,
  };
  appendJsonl("gog-health.jsonl", { at: checkedAt, ok: false, account, error: failure.error });
  const cardResult = await upsertCanaryCard(failure);
  const wake = await wakeOpenClaw(failure, cardResult);
  return { ok: true, ...cardResult, wake };
}

function gogEnv() {
  return {
    ...process.env,
    GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
    GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || "",
    GOG_ACCOUNT,
  };
}

export function runAuthHealthCheck() {
  if (!healthOk || !process.env.GOG_KEYRING_PASSWORD) return;
  execFile(
    GOG_BIN,
    ["auth", "list", "--no-input"],
    {
      env: gogEnv(),
      timeout: 15_000,
    },
    (error, _stdout, stderr) => {
      if (!error) {
        appendJsonl("gog-health.jsonl", { at: new Date().toISOString(), ok: true, account: GOG_ACCOUNT });
        return;
      }

      healthOk = false;
      if (healthInterval) clearInterval(healthInterval);
      const detail = String(stderr || error?.message || "unknown").slice(0, 500);
      handleAuthFailure({ account: GOG_ACCOUNT, error: detail }).catch((handleError) => {
        appendJsonl("errors.jsonl", {
          at: new Date().toISOString(),
          source: "gog-canary-bridge",
          error: handleError?.message || String(handleError),
        });
      });
    },
  );
}

function scheduleHealthChecks() {
  if (SKIP_SCHEDULE || !process.env.GOG_KEYRING_PASSWORD) return;
  runAuthHealthCheck();
  healthInterval = setInterval(runAuthHealthCheck, CHECK_MS).unref();
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, { ok: true, healthOk });
  }

  if (ALLOW_SIMULATE && req.method === "POST" && req.url === "/hooks/gog-canary/simulate") {
    let payload = {};
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString("utf8");
      if (raw) payload = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: "invalid_json" });
    }

    try {
      const result = await handleAuthFailure({
        account: payload.account || GOG_ACCOUNT,
        error: payload.error || "simulated auth failure",
        checkedAt: payload.checkedAt || new Date().toISOString(),
      });
      return sendJson(res, 200, result);
    } catch (error) {
      return sendJson(res, 500, { error: "processing_failed", message: String(error?.message || error) });
    }
  }

  return sendJson(res, 404, { error: "not_found" });
});

if (process.env.GOG_CANARY_AUTOSTART !== "0") {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`gog-canary-bridge listening on ${PORT}`);
    scheduleHealthChecks();
  });
}

export { server, scheduleHealthChecks };
