import http from "node:http";

const PORT = Number(process.env.GMAIL_HOOK_BRIDGE_PORT || 19092);
const ALLOWED_FROM = /adriellpz@gmail\.com/i;
const TRELLO_GATEWAY_URL = process.env.TRELLO_GATEWAY_URL || "";
const TRELLO_GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || "";
const TRELLO_GATEWAY_AGENT_ID = process.env.TRELLO_GATEWAY_AGENT_ID || "main";
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || "";
const TRELLO_INTAKE_LIST_ID = process.env.TRELLO_INTAKE_LIST_ID || "";
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || "";
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || "";
const OPENCLAW_HOOK_AGENT_ID = process.env.OPENCLAW_HOOK_AGENT_ID || "main";
const OPENCLAW_HOOK_SESSION_PREFIX = process.env.OPENCLAW_HOOK_SESSION_PREFIX || "hook:gmail:";
const MAX_BODY_BYTES = Number(process.env.GMAIL_HOOK_MAX_BODY_BYTES || 256 * 1024);
const DONE_LIST_NAMES = (process.env.TRELLO_DONE_LIST_NAMES || "Done")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);
const LIST_CACHE_TTL_MS = Number(process.env.TRELLO_LIST_CACHE_TTL_MS ?? 5 * 60 * 1000);
const HAS_TRELLO_GATEWAY = Boolean(TRELLO_GATEWAY_URL && TRELLO_GATEWAY_KEY);

const wakeDeduper = new Map();
let listNameByIdCache = null;
let listNameByIdCacheTs = 0;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function firstMessage(payload) {
  const messages = payload?.messages;
  return Array.isArray(messages) && messages.length > 0 ? messages[0] : null;
}

function isAllowedSender(from) {
  return ALLOWED_FROM.test(from || "");
}

function shouldWake(dedupeKey) {
  const now = Date.now();
  const previous = wakeDeduper.get(dedupeKey) || 0;
  const dedupeWindowMs = 5 * 60 * 1000;
  if (now - previous < dedupeWindowMs) return false;
  wakeDeduper.set(dedupeKey, now);
  return true;
}

function buildCardTitle(subject) {
  const trimmed = String(subject || "Email task").replace(/\s+/g, " ").trim().slice(0, 80);
  return `P2 - Email: ${trimmed || "Email task"}`;
}

function buildCardDescription(msg) {
  const body = String(msg.body || msg.snippet || "").slice(0, 8000);
  return [
    "Original Request:",
    String(msg.subject || "Email request").trim() || "Email request",
    "",
    "Research:",
    `From: ${msg.from || "unknown"}`,
    `Subject: ${msg.subject || "(no subject)"}`,
    `Gmail message id: ${msg.id || "unknown"}`,
    "",
    body,
    "",
    "Peer Review:",
    "",
    "Work completed:",
  ].join("\n");
}

function buildWakeMessage(msg, cardResult) {
  return [
    "gmail_hook_email_received",
    `from: ${msg.from || "unknown"}`,
    `subject: ${msg.subject || "(no subject)"}`,
    `message_id: ${msg.id || "unknown"}`,
    `trello: ${cardResult.mode} ${cardResult.cardUrl}`,
    "",
    "This card came from an email hook. Only Adriel can send you these hooks (adriellpz@gmail.com).",
    "",
    "Step 0: Style the card (cover, priority tag).",
    "Step 1: Fill `Original Request`, `Research`, `Peer Review`, `Work completed`.",
    "Step 2: Action the item as described in the email. Move to Done when complete.",
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

function cardMatchesMessageId(card, messageId) {
  return new RegExp(`Gmail message id:\\s*${escapeRegExp(messageId)}\\b`).test(String(card?.desc || ""));
}

function buildCardSearchQuery(messageId) {
  return TRELLO_BOARD_ID
    ? `Gmail message id: ${messageId} board:${TRELLO_BOARD_ID}`
    : `Gmail message id: ${messageId}`;
}

async function findExistingOpenCard(messageId) {
  const data = await trelloGatewayRequest("search", { params: { query: buildCardSearchQuery(messageId) } });
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
      return cardMatchesMessageId(card, messageId);
    }) || null
  );
}

async function upsertEmailCard(msg) {
  const messageId = msg.id;
  if (!messageId) throw new Error("missing gmail message id");

  const existing = await findExistingOpenCard(messageId);
  if (existing) {
    return { mode: "updated", cardId: existing.id, cardUrl: existing.url };
  }

  const intakeList = await getIntakeList();
  const created = await trelloGatewayRequest("create_card", {
    params: {
      listName: intakeList.name,
      name: buildCardTitle(msg.subject),
      desc: buildCardDescription(msg),
      pos: "top",
    },
  });
  return {
    mode: "created",
    cardId: created.cardId || created.id,
    cardUrl: created.url || cardUrl(created.shortUrl),
  };
}

async function wakeOpenClaw(msg, cardResult) {
  if (!OPENCLAW_HOOK_URL || !OPENCLAW_HOOK_TOKEN) return { skipped: "openclaw_hook_not_configured" };
  const dedupeKey = `${msg.id}:${cardResult.mode}`;
  if (!shouldWake(dedupeKey)) return { skipped: "deduped_recently" };

  const body = {
    message: buildWakeMessage(msg, cardResult),
    agentId: OPENCLAW_HOOK_AGENT_ID,
    sessionKey: `${OPENCLAW_HOOK_SESSION_PREFIX}${msg.id}`,
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
  return missing;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "POST" || req.url !== "/hooks/gmail") {
    return sendJson(res, 404, { error: "not_found" });
  }

  const missingConfig = basicConfigCheck();
  if (missingConfig.length > 0) {
    return sendJson(res, 500, { error: "missing_config", missing: missingConfig });
  }

  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BODY_BYTES) {
      return sendJson(res, 413, { error: "payload_too_large", maxBytes: MAX_BODY_BYTES });
    }
    chunks.push(chunk);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "invalid_json" });
  }

  const msg = firstMessage(payload);
  if (!msg) return sendJson(res, 400, { error: "missing_messages" });
  if (!isAllowedSender(msg.from)) {
    return sendJson(res, 202, { ok: true, ignored: "sender_not_allowed" });
  }

  try {
    const result = await upsertEmailCard(msg);
    const wake = await wakeOpenClaw(msg, result);
    return sendJson(res, 200, { ok: true, ...result, wake });
  } catch (error) {
    return sendJson(res, 500, { error: "processing_failed", message: String(error?.message || error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`gmail-hook-bridge listening on ${PORT}`);
});
