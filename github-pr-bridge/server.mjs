import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.GITHUB_PR_BRIDGE_PORT || 19091);
const WEBHOOK_SECRET = process.env.GITHUB_PR_WEBHOOK_SECRET || "";
const TRELLO_KEY = process.env.TRELLO_API_KEY || "";
const TRELLO_TOKEN = process.env.TRELLO_API_TOKEN || "";
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || "";
const TRELLO_INTAKE_LIST_ID = process.env.TRELLO_INTAKE_LIST_ID || "";

const RELEVANT_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
  "review_requested",
]);

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

async function getIntakeListId() {
  if (TRELLO_INTAKE_LIST_ID) return TRELLO_INTAKE_LIST_ID;
  if (!TRELLO_BOARD_ID) throw new Error("TRELLO_BOARD_ID is required when TRELLO_INTAKE_LIST_ID is not set");
  const lists = await trelloFetch(`/boards/${encodeURIComponent(TRELLO_BOARD_ID)}/lists?filter=open&fields=id,name`);
  if (!Array.isArray(lists) || lists.length === 0) throw new Error("No open Trello lists found on target board");
  return lists[0].id;
}

async function findExistingOpenCard(prNumber) {
  if (!TRELLO_BOARD_ID) return null;
  const query = `/pull/${prNumber} board:${TRELLO_BOARD_ID}`;
  const data = await trelloFetch(`/search?modelTypes=cards&cards_limit=20&cards_page=0&card_fields=id,name,desc,closed,idList,url&query=${encodeURIComponent(query)}`);
  const cards = Array.isArray(data.cards) ? data.cards : [];
  return cards.find((card) => !card.closed) || null;
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
  const existing = await findExistingOpenCard(prNumber);

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
  for await (const chunk of req) chunks.push(chunk);
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
    return sendJson(res, 200, { ok: true, ...result });
  } catch (error) {
    return sendJson(res, 500, { error: "trello_upsert_failed", message: String(error?.message || error) });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`github-pr-bridge listening on ${PORT}`);
});
