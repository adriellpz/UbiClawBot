import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.GITHUB_PR_BRIDGE_PORT || 19091);
const WEBHOOK_SECRET = process.env.GITHUB_PR_WEBHOOK_SECRET || "";
const TRELLO_KEY = process.env.TRELLO_API_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_API_TOKEN || "";
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || "";
const TRELLO_INTAKE_LIST_ID = process.env.TRELLO_INTAKE_LIST_ID || "";
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || "";
const OPENCLAW_HOOK_TOKEN = process.env.OPENCLAW_HOOK_TOKEN || "";
const OPENCLAW_HOOK_AGENT_ID = process.env.OPENCLAW_HOOK_AGENT_ID || "main";
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
]);
const wakeDeduper = new Map();
let listNameByIdCache = null;

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
  return [
    `PR: ${pr.html_url}`,
    `Title: ${pr.title}`,
    `Action: ${payload.action}`,
    `Author: ${pr.user?.login || "unknown"}`,
    `Branches: ${pr.head?.ref || "?"} -> ${pr.base?.ref || "?"}`,
    `Draft: ${pr.draft ? "yes" : "no"}`,
    `Review requested: ${requestedReviewer}`,
    "",
    "Reminder: Ubi should submit a real GitHub review on this PR.",
    "Adriel remains the final merge gate.",
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

async function getBoardListNameById() {
  if (!TRELLO_BOARD_ID) return new Map();
  if (listNameByIdCache) return listNameByIdCache;
  const lists = await trelloFetch(`/boards/${encodeURIComponent(TRELLO_BOARD_ID)}/lists?filter=all&fields=id,name,closed`);
  listNameByIdCache = new Map((Array.isArray(lists) ? lists : []).map((list) => [list.id, list.name || ""]));
  return listNameByIdCache;
}

async function getIntakeListId() {
  if (TRELLO_INTAKE_LIST_ID) return TRELLO_INTAKE_LIST_ID;
  if (!TRELLO_BOARD_ID) throw new Error("TRELLO_BOARD_ID is required when TRELLO_INTAKE_LIST_ID is not set");
  const lists = await trelloFetch(`/boards/${encodeURIComponent(TRELLO_BOARD_ID)}/lists?filter=open&fields=id,name`);
  if (!Array.isArray(lists) || lists.length === 0) throw new Error("No open Trello lists found on target board");
  return lists[0].id;
}

function cardExactlyMatchesPr(card, prNumber, prUrl) {
  const name = String(card?.name || "");
  const desc = String(card?.desc || "");
  const hasExactPrName = new RegExp(`\\bPR\\s*#?${prNumber}\\b`, "i").test(name);
  const hasExactPrReference =
    desc.includes(prUrl) || new RegExp(`(^|[^0-9])/pull/${prNumber}([^0-9]|$)`).test(desc);
  return hasExactPrName || hasExactPrReference;
}

async function findExistingOpenCard(pullRequest) {
  if (!TRELLO_BOARD_ID) return null;
  const prNumber = pullRequest.number;
  const prUrl = pullRequest.html_url;
  const query = `/pull/${prNumber} board:${TRELLO_BOARD_ID}`;
  const data = await trelloFetch(`/search?modelTypes=cards&cards_limit=20&cards_page=0&card_fields=id,name,desc,closed,idList,url&query=${encodeURIComponent(query)}`);
  const cards = Array.isArray(data.cards) ? data.cards : [];
  const listNameById = await getBoardListNameById();
  return cards.find((card) => {
    if (card.closed) return false;
    const listName = String(listNameById.get(card.idList) || "").trim().toLowerCase();
    if (DONE_LIST_NAMES.includes(listName)) return false;
    return cardExactlyMatchesPr(card, prNumber, prUrl);
  }) || null;
}

async function addCardComment(cardId, text) {
  await trelloFetch(`/cards/${encodeURIComponent(cardId)}/actions/comments`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
}

async function upsertReviewCard(payload) {
  const pr = payload.pull_request;
  const prNumber = pr.number;
  const priority = priorityForEvent(payload.action, pr);
  const cardTitle = buildCardTitle(priority, prNumber);
  const description = buildCardDescription(payload);
  const existing = await findExistingOpenCard(pr);

  if (existing) {
    const comment = [
      `GitHub update: \`${payload.action}\``,
      `PR: ${pr.html_url}`,
      `Head/Base: ${pr.head?.ref || "?"} -> ${pr.base?.ref || "?"}`,
      `Author: ${pr.user?.login || "unknown"}`,
    ].join("\n");
    await addCardComment(existing.id, comment);
    return { mode: "updated", cardId: existing.id, cardUrl: existing.url };
  }

  const listId = await getIntakeListId();
  const created = await trelloFetch("/cards", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      idList: listId,
      name: cardTitle,
      desc: description,
      pos: "top",
    }),
  });
  return { mode: "created", cardId: created.id, cardUrl: created.url };
}

async function wakeOpenClaw(payload, cardResult, githubDeliveryId) {
  if (!OPENCLAW_HOOK_URL || !OPENCLAW_HOOK_TOKEN) return { skipped: "openclaw_hook_not_configured" };
  const pr = payload.pull_request;
  const dedupeKey = `${pr.number}:${payload.action}:${cardResult.mode}:${githubDeliveryId || "none"}`;
  if (!shouldWake(dedupeKey)) return { skipped: "deduped_recently" };

  const message = [
    "github_pr_review_requested",
    `action: ${payload.action}`,
    `pr: #${pr.number} ${pr.title}`,
    `url: ${pr.html_url}`,
    `author: ${pr.user?.login || "unknown"}`,
    `branches: ${pr.head?.ref || "?"} -> ${pr.base?.ref || "?"}`,
    `trello: ${cardResult.mode} ${cardResult.cardUrl}`,
    "",
    "Please review this PR and leave a GitHub review. Adriel is final merge gate.",
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
  if (!TRELLO_KEY) missing.push("TRELLO_API_KEY");
  if (!TRELLO_TOKEN) missing.push("TRELLO_API_TOKEN");
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
    const wake = await wakeOpenClaw(payload, result, req.headers["x-github-delivery"]);
    return sendJson(res, 200, { ok: true, ...result, wake });
  } catch (error) {
    return sendJson(res, 500, { error: "processing_failed", message: String(error?.message || error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`github-pr-bridge listening on ${PORT}`);
});
