import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

import {
  buildPrReviewSearchQuery,
  cardExactlyMatchesPr,
  duplicateReviewCardComment,
  selectCanonicalPrReviewCard,
} from "../shared/pr_review_card.mjs";

const PORT = Number(process.env.GITHUB_PR_BRIDGE_PORT || 19091);
const WEBHOOK_SECRET = process.env.GITHUB_PR_WEBHOOK_SECRET || "";
const TRELLO_GATEWAY_URL = process.env.TRELLO_GATEWAY_URL || "";
const TRELLO_GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || "";
const TRELLO_GATEWAY_AGENT_ID = process.env.TRELLO_GATEWAY_AGENT_ID || "system";
const TRELLO_KEY = process.env.TRELLO_API_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_API_TOKEN || "";
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || "";
const TRELLO_INTAKE_LIST_ID = process.env.TRELLO_INTAKE_LIST_ID || "";
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || "";
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || "";
const OPENCLAW_HOOK_AGENT_ID = process.env.OPENCLAW_HOOK_AGENT_ID || "marcos";
const OPENCLAW_HOOK_SESSION_PREFIX = process.env.OPENCLAW_HOOK_SESSION_PREFIX || "hook:github-pr:";
const MAX_BODY_BYTES = Number(process.env.GITHUB_PR_MAX_BODY_BYTES || 1024 * 1024);
const DONE_LIST_NAMES = (process.env.TRELLO_DONE_LIST_NAMES || "Done")
  .split(",")
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

const RELEVANT_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "review_requested",
  "closed",
]);
const wakeDeduper = new Map();
const LIST_CACHE_TTL_MS = Number(
  process.env.TRELLO_LIST_CACHE_TTL_MS ?? 5 * 60 * 1000,
);
let listNameByIdCache = null;
let listNameByIdCacheTs = 0;
// Coalesces concurrent webhook deliveries for the same PR so the check-then-create
// dedup cannot race two cards into existence (e.g. multiple review_requested events).
const inFlightUpserts = new Map();
// Trello /search can lag behind create_card; remember recent creates so sequential
// deliveries reuse the card before search indexes it.
const recentUpsertByPr = new Map();
const RECENT_UPSERT_TTL_MS = Number(
  process.env.GITHUB_PR_RECENT_UPSERT_TTL_MS ?? 5 * 60 * 1000,
);
const HAS_TRELLO_GATEWAY = Boolean(TRELLO_GATEWAY_URL && TRELLO_GATEWAY_KEY);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function hmacDigest(secret, body) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

function safeHmacCompare(a, b) {
  const aa = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (aa.length !== bb.length) return false;
  return timingSafeEqual(aa, bb);
}

function shouldWake(dedupeKey) {
  const now = Date.now();
  const previous = wakeDeduper.get(dedupeKey) || 0;
  const dedupeWindowMs = 5 * 60 * 1000;
  if (now - previous < dedupeWindowMs) return false;
  wakeDeduper.set(dedupeKey, now);
  if (wakeDeduper.size > 500) {
    // Trim old entries on growth to avoid unbounded memory.
    for (const [key, ts] of wakeDeduper) {
      if (now - ts > dedupeWindowMs) wakeDeduper.delete(key);
      if (wakeDeduper.size <= 300) break;
    }
  }
  return true;
}

function wakeDedupeKey(payload) {
  const pr = payload.pull_request;
  if (payload.action === "closed") return `${pr.number}:closed`;
  return `${pr.number}:${pr.head?.sha || "none"}`;
}

function priorityForEvent(action, pullRequest) {
  const labels = Array.isArray(pullRequest?.labels) ? pullRequest.labels.map((x) => (x?.name || "").toLowerCase()) : [];
  if (labels.some((name) => ["p1", "urgent", "hotfix", "sev1"].includes(name))) return "P1";
  if (action === "review_requested") return "P1";
  return "P2";
}

function buildCardTitle(priority, prNumber) {
  return `${priority} - Review PR ${prNumber}`;
}

function buildCardDescription(payload) {
  const pr = payload.pull_request;
  const requestedReviewer = payload.requested_reviewer?.login || payload.requested_team?.name || "n/a";
  const prTitle = String(pr.title || "").trim() || `PR #${pr.number}`;
  const prLinkLine = pr.html_url
    ? `Review pull request: [#${pr.number} ${prTitle}](${pr.html_url})`
    : `Review pull request: PR #${pr.number} ${prTitle}`;
  return [
    "Original Request:",
    prLinkLine,
    "",
    "Research:",
    `PR: ${pr.html_url}`,
    `Action: ${payload.action}`,
    `Author: ${pr.user?.login || "unknown"}`,
    `Branches: ${pr.head?.ref || "?"} -> ${pr.base?.ref || "?"}`,
    `Draft: ${pr.draft ? "yes" : "no"}`,
    `Review requested: ${requestedReviewer}`,
    "",
    "Peer Review:",
    "",
    "Work completed:",
  ].join("\n");
}

async function trelloFetch(path, init = {}) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `https://api.trello.com/1${path}${sep}key=${encodeURIComponent(TRELLO_KEY)}&token=${encodeURIComponent(TRELLO_TOKEN)}`;
  const res = await fetch(url, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Trello ${res.status}: ${text}`);
  }
  return res.json();
}

async function trelloGatewayRequest(operation, { cardId, params = {} } = {}) {
  const body = {
    agentId: TRELLO_GATEWAY_AGENT_ID,
    operation,
    params,
  };
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
  if (HAS_TRELLO_GATEWAY) {
    const data = await trelloGatewayRequest("board_lists");
    return Array.isArray(data.lists) ? data.lists : [];
  }
  if (!TRELLO_BOARD_ID) return [];
  const filter = includeClosed ? "all" : "open";
  return trelloFetch(`/boards/${encodeURIComponent(TRELLO_BOARD_ID)}/lists?filter=${filter}&fields=id,name,closed`);
}

async function getBoardListNameById() {
  if (!HAS_TRELLO_GATEWAY && !TRELLO_BOARD_ID) return new Map();
  const now = Date.now();
  if (listNameByIdCache && now - listNameByIdCacheTs < LIST_CACHE_TTL_MS) return listNameByIdCache;
  const lists = await getBoardLists({ includeClosed: true });
  listNameByIdCache = new Map((Array.isArray(lists) ? lists : []).map((list) => [list.id, list.name || ""]));
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

function rememberRecentUpsert(prNumber, result) {
  if (!result?.cardId) return;
  recentUpsertByPr.set(prNumber, {
    cardId: result.cardId,
    cardUrl: result.cardUrl,
    ts: Date.now(),
  });
  if (recentUpsertByPr.size > 500) {
    const now = Date.now();
    for (const [key, entry] of recentUpsertByPr) {
      if (now - entry.ts > RECENT_UPSERT_TTL_MS) recentUpsertByPr.delete(key);
      if (recentUpsertByPr.size <= 300) break;
    }
  }
}

function getRecentUpsert(prNumber) {
  const entry = recentUpsertByPr.get(prNumber);
  if (!entry) return null;
  if (Date.now() - entry.ts > RECENT_UPSERT_TTL_MS) {
    recentUpsertByPr.delete(prNumber);
    return null;
  }
  return entry;
}

async function findMatchingReviewCards(pullRequest) {
  const prNumber = pullRequest.number;
  const prUrl = pullRequest.html_url;
  const query = buildPrReviewSearchQuery(prNumber, TRELLO_BOARD_ID);
  // cards_limit 50: a PR rarely has more than a few matching cards; headroom catches
  // duplicate Done + active cards without hitting Trello's 1000 cap on narrow queries.
  const data = HAS_TRELLO_GATEWAY
    ? await trelloGatewayRequest("search", { params: { query } })
    : await trelloFetch(`/search?modelTypes=cards&cards_limit=50&cards_page=0&card_fields=id,name,desc,closed,idList,url,shortUrl&query=${encodeURIComponent(query)}`);
  const cards = (Array.isArray(data.cards) ? data.cards : []).map((card) => ({
    ...card,
    url: card.url || cardUrl(card.shortUrl),
  }));
  const listNameById = await getBoardListNameById();
  return cards
    .filter((card) => cardExactlyMatchesPr(card, prNumber, prUrl))
    .map((card) => ({
      ...card,
      listName: String(listNameById.get(card.idList) || "").trim(),
    }));
}

async function addCardComment(cardId, text) {
  if (HAS_TRELLO_GATEWAY) {
    await trelloGatewayRequest("comment", {
      cardId,
      params: { text },
    });
    return;
  }

  await trelloFetch(`/cards/${encodeURIComponent(cardId)}/actions/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

function buildUpdateComment(payload) {
  const pr = payload.pull_request;
  return [
    `GitHub update: \`${payload.action}\``,
    `PR: ${pr.html_url}`,
    `Head/Base: ${pr.head?.ref || "?"} -> ${pr.base?.ref || "?"}`,
    `Author: ${pr.user?.login || "unknown"}`,
  ].join("\n");
}

async function upsertReviewCard(payload) {
  const prNumber = payload.pull_request.number;

  // If another delivery for this PR is mid-flight, wait for it and comment on the
  // card it produced instead of racing a duplicate through the dedup check.
  // Note: coalesced waiters only get the update comment; duplicate-card notices
  // run inside the leader's doUpsertReviewCard (pre-existing dupes are rare here).
  const inFlight = inFlightUpserts.get(prNumber);
  if (inFlight) {
    const prior = await inFlight.catch(() => null);
    if (prior?.cardId) {
      await addCardComment(prior.cardId, buildUpdateComment(payload));
      return { mode: "updated", cardId: prior.cardId, cardUrl: prior.cardUrl };
    }
  }

  const recent = getRecentUpsert(prNumber);
  if (recent) {
    await addCardComment(recent.cardId, buildUpdateComment(payload));
    return { mode: "updated", cardId: recent.cardId, cardUrl: recent.cardUrl };
  }

  const promise = doUpsertReviewCard(payload);
  inFlightUpserts.set(prNumber, promise);
  try {
    const result = await promise;
    if (result.mode === "created") rememberRecentUpsert(prNumber, result);
    return result;
  } finally {
    if (inFlightUpserts.get(prNumber) === promise) inFlightUpserts.delete(prNumber);
  }
}

async function doUpsertReviewCard(payload) {
  const pr = payload.pull_request;
  const prNumber = pr.number;
  const priority = priorityForEvent(payload.action, pr);
  const cardTitle = buildCardTitle(priority, prNumber);
  const description = buildCardDescription(payload);
  const matches = await findMatchingReviewCards(pr);
  const { canonical, duplicates } = selectCanonicalPrReviewCard(matches, { doneListNames: DONE_LIST_NAMES });

  if (canonical) {
    const updateComment = buildUpdateComment(payload);
    await addCardComment(canonical.id, updateComment);
    for (const duplicate of duplicates) {
      await addCardComment(duplicate.id, duplicateReviewCardComment(canonical.url));
    }
    return {
      mode: "updated",
      cardId: canonical.id,
      cardUrl: canonical.url,
      duplicatesNotified: duplicates.length,
    };
  }

  const intakeList = await getIntakeList();
  if (HAS_TRELLO_GATEWAY) {
    const created = await trelloGatewayRequest("create_card", {
      params: {
        listName: intakeList.name,
        name: cardTitle,
        desc: description,
        pos: "top",
      },
    });
    return {
      mode: "created",
      cardId: created.cardId || created.id,
      cardUrl: created.url || cardUrl(created.shortUrl),
    };
  }

  const created = await trelloFetch("/cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idList: intakeList.id,
      name: cardTitle,
      desc: description,
      pos: "top",
    }),
  });
  return { mode: "created", cardId: created.id, cardUrl: created.url };
}

async function wakeOpenClaw(payload, cardResult) {
  if (!OPENCLAW_HOOK_URL || !OPENCLAW_HOOK_TOKEN) return { skipped: "openclaw_hook_not_configured" };
  const pr = payload.pull_request;
  const dedupeKey = wakeDedupeKey(payload);
  if (!shouldWake(dedupeKey)) return { skipped: "deduped_recently" };

  const isClosed = payload.action === "closed";
  const instructionLines = isClosed
    ? [
        "PR closed; update Trello with the current GitHub outcome. Move to Done unless already in Done or Archived. Do not reopen.",
      ]
    : [
        "Step 0: Style the card (cover, priority tag).",
        "Step 1: Fill `Original Request`, `Research`, `Peer Review`, `Work completed`.",
        "Step 2: Leave a GitHub review on this PR, request changes if needed, copy findings into the card Peer Review section, then move the card to Done when complete.",
        "Adriel is the final merge gate — do not merge.",
      ];
  const message = [
    isClosed ? "github_pr_closed" : "github_pr_review_requested",
    `action: ${payload.action}`,
    `pr: #${pr.number} ${pr.title}`,
    `url: ${pr.html_url}`,
    `author: ${pr.user?.login || "unknown"}`,
    `branches: ${pr.head?.ref || "?"} -> ${pr.base?.ref || "?"}`,
    `trello: ${cardResult.mode} ${cardResult.cardUrl}`,
    "",
    ...instructionLines,
  ].join("\n");

  // /hooks/agent expects a message body; keep the payload shape compatible.
  const body = {
    message,
    agentId: OPENCLAW_HOOK_AGENT_ID,
    sessionKey: `${OPENCLAW_HOOK_SESSION_PREFIX}${pr.number}`,
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
  if (!WEBHOOK_SECRET) missing.push("GITHUB_PR_WEBHOOK_SECRET");
  const hasGateway = Boolean(TRELLO_GATEWAY_URL && TRELLO_GATEWAY_KEY);
  const hasDirect = Boolean(TRELLO_KEY && TRELLO_TOKEN);
  if (!hasGateway && !hasDirect) {
    if (TRELLO_GATEWAY_URL || TRELLO_GATEWAY_KEY) {
      if (!TRELLO_GATEWAY_URL) missing.push("TRELLO_GATEWAY_URL");
      if (!TRELLO_GATEWAY_KEY) missing.push("TRELLO_GATEWAY_KEY");
    }
    if (TRELLO_KEY || TRELLO_TOKEN) {
      if (!TRELLO_KEY) missing.push("TRELLO_API_KEY");
      if (!TRELLO_TOKEN) missing.push("TRELLO_API_TOKEN");
    }
    if (missing.length === 1 && missing[0] === "GITHUB_PR_WEBHOOK_SECRET") {
      missing.push("TRELLO_GATEWAY_URL + TRELLO_GATEWAY_KEY or TRELLO_API_KEY + TRELLO_API_TOKEN");
    }
    if (missing.length === 0) {
      missing.push("TRELLO_GATEWAY_URL + TRELLO_GATEWAY_KEY or TRELLO_API_KEY + TRELLO_API_TOKEN");
    }
  }
  if (!TRELLO_BOARD_ID && !TRELLO_INTAKE_LIST_ID) missing.push("TRELLO_BOARD_ID or TRELLO_INTAKE_LIST_ID");
  return missing;
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }
  if (req.method !== "POST" || req.url !== "/github-pr") {
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
  const rawBody = Buffer.concat(chunks);

  const signature = req.headers["x-hub-signature-256"];
  if (typeof signature !== "string") {
    return sendJson(res, 401, { error: "missing_signature" });
  }
  const expected = hmacDigest(WEBHOOK_SECRET, rawBody);
  if (!safeHmacCompare(signature, expected)) {
    return sendJson(res, 401, { error: "invalid_signature" });
  }

  const event = req.headers["x-github-event"];
  if (event !== "pull_request") {
    return sendJson(res, 202, { ok: true, ignored: "event_not_supported" });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return sendJson(res, 400, { error: "invalid_json" });
  }

  if (!RELEVANT_ACTIONS.has(payload.action)) {
    return sendJson(res, 202, { ok: true, ignored: `action_${payload.action || "unknown"}` });
  }

  try {
    const result = await upsertReviewCard(payload);
    const wake = await wakeOpenClaw(payload, result);
    return sendJson(res, 200, { ok: true, ...result, wake });
  } catch (error) {
    return sendJson(res, 500, { error: "processing_failed", message: String(error?.message || error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`github-pr-bridge listening on ${PORT}`);
});
