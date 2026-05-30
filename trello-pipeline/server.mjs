#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { isPrReviewCard } from "../shared/pr_review_card.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.TRELLO_PIPELINE_STATE_DIR || "/var/lib/trello-pipeline";
fs.mkdirSync(STATE, { recursive: true });

function loadEnv(file) {
  if (!file || !fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

loadEnv(process.env.TRELLO_PIPELINE_ENV_FILE);

const PORT = Number(process.env.PORT || 18990);
const TOKEN = process.env.TRELLO_BRIDGE_TOKEN;
const APP_SECRET = process.env.TRELLO_APP_SECRET || "";
const CALLBACK_URL = process.env.TRELLO_CALLBACK_URL || "";
const TRELLO_API_KEY = process.env.TRELLO_API_KEY || "";
const TRELLO_API_TOKEN = process.env.TRELLO_API_TOKEN || "";
const TRELLO_BOARD_ID = process.env.TRELLO_BOARD_ID || "69f96aafc342ad1c89f48e0c";
if (!TOKEN) throw new Error("TRELLO_BRIDGE_TOKEN missing");

const GATEWAY_URL = (process.env.TRELLO_GATEWAY_URL || "http://trello-gateway:18792").replace(/\/$/, "");
const GATEWAY_KEY = process.env.TRELLO_GATEWAY_KEY || process.env.GATEWAY_KEY || "";

const OPENCLAW_CONFIG = process.env.OPENCLAW_CONFIG || "/home/node/.openclaw/openclaw.json";
const OPENCLAW_HOOK_URL = process.env.OPENCLAW_HOOK_URL || "http://127.0.0.1:18789/hooks/agent";
const pendingFile = path.join(STATE, "actionable_pending.jsonl");
const queuedIdsFile = path.join(STATE, "actionable_queued_ids.json");
const wakeIdsFile = path.join(STATE, "actionable_wake_ids.json");
const wakeRetryFile = path.join(STATE, "actionable_wake_retry.json");
const pollCursorFile = path.join(STATE, "bridge_poll_cursor.json");
const processedActionsFile = path.join(STATE, "processed_actions.json");

// A failed wake (e.g. a transient HTTP 502 from the hook) used to orphan the card:
// the event is queued/handled but the agent is never woken and nothing retries.
// Failed wakes are re-attempted on the poll interval, up to this many tries.
const MAX_WAKE_ATTEMPTS = Number(process.env.TRELLO_BRIDGE_MAX_WAKE_ATTEMPTS || 6);

const GOG_HEALTH_CHECK_MS = 300_000;
const GOG_ACCOUNT = process.env.GOG_ACCOUNT || "ubitheai@gmail.com";

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
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

function redactSecrets(value) {
  if (!value || typeof value !== "object") {
    if (typeof value === "string" && TOKEN) return value.split(TOKEN).join("[redacted]");
    return value;
  }
  if (Array.isArray(value)) return value.map(redactSecrets);
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, redactSecrets(nested)]));
}

function appendJsonl(name, obj) {
  fs.appendFileSync(path.join(STATE, name), `${JSON.stringify(redactSecrets(obj))}\n`);
}

function appendJsonlPath(file, obj) {
  fs.appendFileSync(file, `${JSON.stringify(redactSecrets(obj))}\n`);
}

function send(res, code, body = "") {
  res.writeHead(code, { "content-type": "text/plain; charset=utf-8" });
  res.end(body);
}

function isAgentMember(action) {
  const usernames = ["ubitheai1", "marcostheai", "cheryltheai", "systemworker"];
  return usernames.includes(action?.memberCreator?.username);
}

function isListMove(action) {
  const data = action?.data || {};
  return (
    action?.type === "updateCard" &&
    data.old?.idList &&
    data.listBefore?.name &&
    data.listAfter?.name &&
    data.listBefore.name !== data.listAfter.name
  );
}

function isDeterministicHandlerMove(action) {
  if (!isListMove(action)) return false;
  const after = action.data.listAfter.name;
  return /\breschedule\b/i.test(after) || after === "Done" || after === "Missed";
}

function isMarcosMentioningUbi(action) {
  if (action?.type !== "commentCard") return false;
  if (action?.memberCreator?.username !== "marcostheai") return false;
  return /@ubitheai1\b/i.test(action?.data?.text || "");
}

function isUbiMentioningMarcos(action) {
  if (action?.type !== "commentCard") return false;
  if (action?.memberCreator?.username !== "ubitheai1") return false;
  return /@marcostheai\b/i.test(action?.data?.text || "");
}

function isAgentBacklogCreate(action) {
  return action?.type === "createCard" && action?.data?.list?.name === "Backlog";
}

function isBacklogIntake(actionable) {
  const kind = actionable?.kind;
  if (kind === "trello_card_moved_to_backlog") return true;
  if (kind === "trello_card_created" && actionable?.listName === "Backlog") return true;
  return false;
}

function shouldSkipUbiWakeForPrReviewCard(actionable) {
  return isBacklogIntake(actionable) && isPrReviewCard(actionable);
}

function actionableFromAction(action) {
  const type = action.type;
  const data = action.data || {};
  const card = data.card || {};
  const creator = action.memberCreator || {};

  if (
    isAgentMember(action) &&
    !isDeterministicHandlerMove(action) &&
    !isMarcosMentioningUbi(action) &&
    !isUbiMentioningMarcos(action) &&
    !isAgentBacklogCreate(action)
  ) {
    return null;
  }

  if (type === "updateCard" && Object.prototype.hasOwnProperty.call(data.old || {}, "dueComplete")) return null;
  if (type === "deleteCard") return null;

  if (
    type === "updateCard" &&
    data.old?.idList &&
    data.listBefore?.name &&
    data.listAfter?.name &&
    data.listBefore?.name !== data.listAfter?.name
  ) {
    return {
      kind: /\breschedule\b/i.test(data.listAfter?.name || "")
        ? "trello_card_moved_to_reschedule"
        : data.listAfter?.name === "Backlog"
          ? "trello_card_moved_to_backlog"
          : data.listAfter?.name === "Blocked"
            ? "trello_card_moved_to_blocked"
            : data.listAfter?.name === "Done"
              ? "trello_card_moved_to_done"
              : data.listAfter?.name === "Missed"
                ? "trello_card_moved_to_missed"
                : "trello_card_moved",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.listAfter?.name,
      fromListName: data.listBefore?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      text: `Moved to ${data.listAfter?.name || "unknown list"} from ${data.listBefore?.name || "unknown list"}`,
    };
  }

  if (type === "createCard") {
    return {
      kind: "trello_card_created",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      text: data.text || "",
    };
  }

  if (type === "commentCard") {
    const text = data.text || "";
    if (!/@/.test(text)) return null;
    return {
      kind: /@ubitheai1\b/i.test(text) ? "trello_ubi_mention" : "trello_card_comment",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      text,
    };
  }

  if (type === "updateCard" && Object.prototype.hasOwnProperty.call(data.old || {}, "due") && card.id) {
    return {
      kind: "trello_card_due_changed",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      oldDue: data.old.due,
      newDue: data.card?.due,
      text: `Due date changed from ${data.old.due || "none"} to ${data.card?.due || "none"}`,
    };
  }

  if (type === "updateCard" && Object.prototype.hasOwnProperty.call(data.old || {}, "name") && card.id) {
    return {
      kind: "trello_card_renamed",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      oldName: data.old.name,
      text: `Renamed from "${data.old.name}" to "${card.name}"`,
    };
  }

  if (type === "updateCard" && Object.prototype.hasOwnProperty.call(data.old || {}, "desc") && card.id) {
    return {
      kind: "trello_card_description_changed",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      text: "Description updated",
    };
  }

  if (type === "addAttachmentToCard") {
    return {
      kind: "trello_card_attachment_added",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      attachmentUrl: data.attachment?.url,
      attachmentName: data.attachment?.name,
      text: `Attachment added: ${data.attachment?.name || "unknown"}`,
    };
  }

  if (type === "addChecklistToCard") {
    return {
      kind: "trello_card_checklist_added",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      checklistName: data.checklist?.name,
      text: `Checklist added: ${data.checklist?.name || "unknown"}`,
    };
  }

  if (type === "updateCheckItemStateOnCard" && data.checkItem?.state === "complete") {
    return {
      kind: "trello_checklist_item_completed",
      at: new Date().toISOString(),
      actionId: action.id,
      actor: creator.username || creator.fullName || "unknown",
      cardId: card.id,
      cardName: card.name,
      cardShortLink: card.shortLink,
      listName: data.list?.name,
      url: card.shortLink ? `https://trello.com/c/${card.shortLink}` : undefined,
      checkItemName: data.checkItem?.name,
      checklistName: data.checklist?.name,
      text: `Checklist item completed: ${data.checkItem?.name || "unknown"}`,
    };
  }

  return null;
}

function actionableFromTrelloAction(payload) {
  return actionableFromAction(payload?.action || {});
}

function hookToken() {
  if (process.env.OPENCLAW_HOOK_TOKEN) return process.env.OPENCLAW_HOOK_TOKEN;
  try {
    const config = safeJsonParse(fs.readFileSync(OPENCLAW_CONFIG, "utf8")) || {};
    return config?.hooks?.token || "";
  } catch {
    return "";
  }
}

function queueActionable(actionable) {
  if (!actionable?.actionId) return { queued: false, reason: "missing-action-id" };
  const processed = new Set(readJson(processedActionsFile, []));
  if (processed.has(actionable.actionId)) return { queued: false, reason: "already_processed" };
  processed.add(actionable.actionId);
  writeJson(processedActionsFile, [...processed].slice(-5000));

  const queued = new Set(readJson(queuedIdsFile, []));
  if (queued.has(actionable.actionId)) return { queued: false, reason: "duplicate" };
  appendJsonlPath(pendingFile, {
    ...actionable,
    queuedAt: new Date().toISOString(),
    status: "pending",
    source: "trello-webhook-bridge",
  });
  queued.add(actionable.actionId);
  writeJson(queuedIdsFile, [...queued].slice(-2000));
  return { queued: true };
}

async function trelloApi(pathname, params = {}) {
  if (!TRELLO_API_KEY || !TRELLO_API_TOKEN) throw new Error("missing Trello API credentials");
  const url = new URL(`https://api.trello.com/1${pathname}`);
  url.searchParams.set("key", TRELLO_API_KEY);
  url.searchParams.set("token", TRELLO_API_TOKEN);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) throw new Error(`Trello API HTTP ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

function wakeTarget(actionable) {
  const kind = actionable?.kind;
  if (kind === "trello_card_moved_to_reschedule" || kind === "trello_card_moved_to_done" || kind === "trello_card_moved_to_missed") return null;
  if (kind === "trello_card_moved_to_blocked") return "marcos";
  if (kind === "trello_card_moved") return null;
  if (
    [
      "trello_card_due_changed",
      "trello_card_renamed",
      "trello_card_description_changed",
      "trello_card_attachment_added",
      "trello_card_checklist_added",
      "trello_checklist_item_completed",
    ].includes(kind)
  ) {
    return null;
  }
  if (kind === "trello_card_comment" || kind === "trello_ubi_mention") {
    const text = actionable.text || "";
    if (/@marcostheai\b/i.test(text)) return "marcos";
    if (/@ubitheai1\b/i.test(text)) return "main";
    if (/@cheryltheai\b/i.test(text)) return "scheduler";
    return null;
  }
  if (shouldSkipUbiWakeForPrReviewCard(actionable)) return null;
  return "main";
}

async function wakeOpenClaw(actionable, targetAgent) {
  if (!actionable?.actionId) return { woke: false, reason: "missing-action-id" };
  const wokeIds = new Set(readJson(wakeIdsFile, []));
  if (wokeIds.has(actionable.actionId)) return { woke: false, reason: "duplicate" };
  const token = hookToken();
  if (!token) return { woke: false, reason: "missing-hook-token" };
  const marcosHookRules = [
    "- Do not merely acknowledge/queue; work to complete the task or raise a comment to @adriellopez1",
    "- For calendar event creation or reschedule, move the card directly to the Reschedule list and scheduling will happen automatically.",
    "- Prefer Trello-only delivery for routine Trello housekeeping updates.",
  ];
  const backlogIntakeRules = [
    "- Do not merely acknowledge or queue. Work to complete the task, or move the card to the Blocked list with a comment that explains exactly why you are blocked. Order is mandatory: comment first, then move.",
    "- A peer review is optional: request one from @marcostheai only when the request or card is more technical in nature (code, infra, deploy, security, architecture). PR review is a Marcos task — route any PR review to @marcostheai.",
    "- Calendar events are only required when something specific is needed from @adriellopez1.",
    "- For calendar event creation or reschedule: comment on the card why the time is needed on Adriel's calendar, add Time needed: N (minutes) in the card description, then move the card directly to the Reschedule list; scheduling will happen automatically.",
    "- Prefer Trello-only delivery for routine Trello housekeeping updates.",
  ];
  const defaultUbiHookRules = [
    "- Do not merely acknowledge/queue; either handle safely or make a visible follow-up state.",
    "- Never move cards directly to Scheduled (gateway blocks this). For calendar time: comment, set Time needed in description, move to Reschedule only.",
    "- For calendar reschedules, move existing events rather than creating duplicates.",
    "- If Adriel says Trello/Ubi-only, do not create calendar events.",
    "- Prefer Trello-only delivery for routine Trello housekeeping updates.",
  ];
  const backlogIntakeProcedure = [
    "0. Style the card (cover, priority tag).",
    "1. Copy the original title into the description as `Original Request:\\n{original title}`.",
    "2. Add priority as a prefix to the title and update the title to a short descriptive name.",
    "3. Update the description so it has these sections in this exact order: `Original Request`, `Research`, `Peer Review`, `Work completed`.",
    '   Research: {search the web if relevant; also search existing board cards via gateway search (operation search, query string) and note related cards/links; otherwise "Not relevant"}',
    "   Peer Review: leave blank unless you request a review. Only Marcos may fill it — when he comments, copy his findings into this section.",
    "   Work completed: leave blank until actual progress happens, then append short dated milestone lines only.",
    "4. If the request or card is more technical in nature, comment @marcostheai from this card asking for feedback and leave the card in Backlog until he replies. Do not move to Blocked while waiting on Marcos. PR reviews are a Marcos task — route them to @marcostheai. Otherwise proceed without a review.",
    "5. Only move to Blocked for a concrete external blocker (comment first, then move).",
    "6. Only move the card to Done when the task has actually been completed.",
  ];
  const hookRules =
    targetAgent === "marcos"
      ? marcosHookRules
      : targetAgent === "main" && isBacklogIntake(actionable)
        ? backlogIntakeRules
        : defaultUbiHookRules;
  const procedureLines = targetAgent === "main" && isBacklogIntake(actionable) ? backlogIntakeProcedure : null;
  const textParts = [
    "Trello actionable event received. Handle this now using Trello as source of truth.",
    "",
    "REMINDER: If this Trello update came in via webhook, your response/update should be posted on Trello (card comment/move) unless Adriel specifically asked for Telegram/chat response.",
    "",
    "Rules:",
    ...hookRules,
  ];
  if (procedureLines) {
    textParts.push("", "Procedure (follow in order):", ...procedureLines);
  }
  textParts.push("", "Event JSON:", JSON.stringify(actionable, null, 2));
  const text = textParts.join("\n");

  const response = await fetch(OPENCLAW_HOOK_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ text, message: text, mode: "now", agentId: targetAgent || "main" }),
  });
  const body = await response.text().catch(() => "");
  if (!response.ok) return { woke: false, reason: `HTTP ${response.status}`, body: body.slice(0, 200) };

  wokeIds.add(actionable.actionId);
  writeJson(wakeIdsFile, [...wokeIds].slice(-2000));
  return { woke: true };
}

// A wake counts as delivered if it landed or was already woken ("duplicate").
// Reasons tied to "no wake intended" (silent_move, queue-worker-owned, no action id)
// are not retryable; everything else (HTTP 5xx, timeouts, missing token) is.
function wakeDelivered(wake) {
  return Boolean(wake?.woke) || wake?.reason === "duplicate";
}

function noteWakeOutcome(actionable, target, wake) {
  if (!actionable?.actionId) return;
  const retries = readJson(wakeRetryFile, {});
  const nonRetryableReasons = ["missing-action-id", "silent_move", "handled_by_queue_worker"];
  const retryable = Boolean(target) && !wakeDelivered(wake) && !nonRetryableReasons.includes(wake?.reason);
  if (!retryable) {
    if (retries[actionable.actionId]) {
      delete retries[actionable.actionId];
      writeJson(wakeRetryFile, retries);
    }
    return;
  }
  const prev = retries[actionable.actionId];
  retries[actionable.actionId] = {
    actionable,
    target,
    attempts: (prev?.attempts || 0) + 1,
    firstAt: prev?.firstAt || new Date().toISOString(),
    lastAt: new Date().toISOString(),
    lastReason: wake?.reason || "unknown",
  };
  const keys = Object.keys(retries);
  if (keys.length > 500) for (const key of keys.slice(0, keys.length - 500)) delete retries[key];
  writeJson(wakeRetryFile, retries);
}

async function retryFailedWakes() {
  const retries = readJson(wakeRetryFile, {});
  const ids = Object.keys(retries);
  if (ids.length === 0) return;
  let changed = false;
  for (const actionId of ids) {
    const entry = retries[actionId];
    if (entry.attempts >= MAX_WAKE_ATTEMPTS) {
      delete retries[actionId];
      changed = true;
      appendJsonl("errors.jsonl", {
        at: new Date().toISOString(),
        source: "wake-retry",
        error: "gave up re-waking actionable",
        actionId,
        attempts: entry.attempts,
        lastReason: entry.lastReason,
        card: entry.actionable?.cardName,
      });
      continue;
    }
    const wake = await wakeOpenClaw(entry.actionable, entry.target).catch((error) => ({
      woke: false,
      reason: error?.message || String(error),
    }));
    appendJsonl("wakes.jsonl", {
      at: new Date().toISOString(),
      actionId,
      wake,
      target: entry.target,
      source: "wake-retry",
      attempt: entry.attempts + 1,
    });
    if (wakeDelivered(wake)) {
      delete retries[actionId];
    } else {
      entry.attempts += 1;
      entry.lastAt = new Date().toISOString();
      entry.lastReason = wake?.reason || "unknown";
    }
    changed = true;
  }
  if (changed) writeJson(wakeRetryFile, retries);
}

async function pollTrelloFallback() {
  const actions = await trelloApi(`/boards/${TRELLO_BOARD_ID}/actions`, {
    limit: "50",
    filter: "commentCard,createCard,updateCard,deleteCard,addAttachmentToCard,addChecklistToCard,updateCheckItemStateOnCard",
  });
  const cursor = readJson(pollCursorFile, {});
  let unseen = [];
  if (cursor.latestSeenActionId) {
    for (const action of actions) {
      if (action.id === cursor.latestSeenActionId) break;
      unseen.push(action);
    }
  } else {
    const cutoff = Date.now() - 15 * 60 * 1000;
    unseen = actions.filter((action) => Date.parse(action.date || 0) >= cutoff);
  }

  for (const action of unseen.reverse()) {
    const actionable = actionableFromAction(action);
    if (!actionable) continue;
    actionable.source = "trello-poll-fallback";
    appendJsonl("actionable.jsonl", actionable);
    const queued = queueActionable(actionable);
    const target = wakeTarget(actionable);
    const wake = target
      ? await wakeOpenClaw(actionable, target).catch((error) => ({ woke: false, reason: error?.message || String(error) }))
      : { woke: false, reason: actionable.kind === "trello_card_moved_to_reschedule" ? "handled_by_queue_worker" : "silent_move" };
    appendJsonl("wakes.jsonl", {
      at: new Date().toISOString(),
      actionId: actionable.actionId,
      queued,
      wake,
      source: "trello-poll-fallback",
    });
    noteWakeOutcome(actionable, target, wake);
  }

  if (actions[0]) {
    writeJson(pollCursorFile, {
      latestSeenActionId: actions[0].id,
      latestSeenDate: actions[0].date,
      updatedAt: new Date().toISOString(),
    });
  }
  return unseen.length;
}

let gogHealthOk = true;
let gogHealthInterval = null;

function gogAuthHealthCheck() {
  if (!gogHealthOk || !process.env.GOG_KEYRING_PASSWORD) return;
  const gogBin = process.env.GOG_BIN || "gog";
  execFile(
    gogBin,
    ["auth", "list", "--no-input"],
    {
      env: {
        ...process.env,
        GOG_KEYRING_BACKEND: process.env.GOG_KEYRING_BACKEND || "file",
        GOG_KEYRING_PASSWORD: process.env.GOG_KEYRING_PASSWORD || "",
        GOG_ACCOUNT,
      },
      timeout: 15_000,
    },
    (error, stdout, stderr) => {
      if (!error) {
        appendJsonl("gog-health.jsonl", { at: new Date().toISOString(), ok: true });
        return;
      }

      gogHealthOk = false;
      if (gogHealthInterval) clearInterval(gogHealthInterval);
      const detail = String(stderr || error?.message || "unknown").slice(0, 500);
      appendJsonl("gog-health.jsonl", { at: new Date().toISOString(), ok: false, error: detail });
      const token = hookToken();
      if (!token) return;

      const text = [
        "GOG Auth Health Canary - FAILED",
        "",
        "The periodic gog auth health check detected an authentication failure.",
        "Create a Trello card on the Ubi Command Board to track re-auth.",
        "Tag @adriellopez1 on the card so it gets eyes.",
        "",
        `Account: ${GOG_ACCOUNT}`,
        `Error: ${detail}`,
        `Timestamp: ${new Date().toISOString()}`,
      ].join("\n");

      fetch(OPENCLAW_HOOK_URL, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ text, message: text, mode: "now", agentId: "main" }),
      }).catch(() => {});
    },
  );
}

async function checkGatewayHealth() {
  const health = await fetch(`${GATEWAY_URL}/healthz`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok) throw new Error(`gateway healthz HTTP ${health.status}`);
  if (!GATEWAY_KEY) return { connected: true, via: "gateway", reachable: true, boardId: null, agents: null };

  const response = await fetch(GATEWAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify({ agentId: "system", operation: "status", cardId: "board" }),
    signal: AbortSignal.timeout(8000),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok || !data.success) {
    throw new Error(data.error || data.details || `gateway status HTTP ${response.status}`);
  }

  return {
    connected: true,
    via: "gateway",
    boardId: data.boardId,
    agents: data.agents,
    transitions: data.transitions,
  };
}

function verifySignature(rawBody, req) {
  if (!APP_SECRET) return { ok: true, skipped: true };
  const header = req.headers["x-trello-webhook"];
  if (!header) return { ok: false, reason: "missing x-trello-webhook" };
  const callback = CALLBACK_URL || `http://${req.headers.host}${req.url}`;
  const digest = crypto.createHmac("sha1", APP_SECRET).update(rawBody + callback).digest("base64");
  return { ok: crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(String(header))), skipped: false };
}

function applyTrelloAction(payload) {
  const action = payload?.action || {};
  return { changed: false, summary: "Trello source-of-truth event logged.", type: action.type };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if ((url.pathname === "/health" || url.pathname === "/healthz") && req.method === "GET") {
    const pollFallback = { enabled: Boolean(TRELLO_API_KEY && TRELLO_API_TOKEN) };
    checkGatewayHealth()
      .then((trello) => send(res, 200, JSON.stringify({ status: "ok", uptime: process.uptime(), port: PORT, trello, pollFallback })))
      .catch((error) =>
        send(
          res,
          503,
          JSON.stringify({
            status: "degraded",
            uptime: process.uptime(),
            port: PORT,
            trello: { connected: false, via: "gateway", error: error.message },
          }),
        ),
      );
    return;
  }

  if (url.pathname !== "/trello") return send(res, 404, "not found");
  if (url.searchParams.get("token") !== TOKEN) return send(res, 401, "bad token");
  if (req.method === "HEAD") return send(res, 200);
  if (req.method === "GET") return send(res, 200, "trello bridge ok");
  if (req.method !== "POST") return send(res, 405, "method not allowed");

  let raw = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > 1024 * 512) req.destroy();
  });
  req.on("end", () => {
    const signature = verifySignature(raw, req);
    if (!signature.ok) return send(res, 401, "bad signature");

    const payload = safeJsonParse(raw);
    if (!payload) return send(res, 400, "bad json");

    appendJsonl("events.jsonl", {
      at: new Date().toISOString(),
      headers: { "x-trello-webhook": Boolean(req.headers["x-trello-webhook"]) },
      payload,
    });
    appendJsonl("applied.jsonl", { at: new Date().toISOString(), result: applyTrelloAction(payload) });

    const actionable = actionableFromTrelloAction(payload);
    if (actionable) {
      appendJsonl("actionable.jsonl", actionable);
      const queued = queueActionable(actionable);
      const target = wakeTarget(actionable);
      if (target) {
        wakeOpenClaw(actionable, target)
          .then((wake) => {
            appendJsonl("wakes.jsonl", { at: new Date().toISOString(), actionId: actionable.actionId, queued, wake, target });
            noteWakeOutcome(actionable, target, wake);
          })
          .catch((error) => {
            const wake = { woke: false, reason: error?.message || String(error) };
            appendJsonl("wakes.jsonl", { at: new Date().toISOString(), actionId: actionable.actionId, queued, wake, target });
            noteWakeOutcome(actionable, target, wake);
          });
      } else {
        appendJsonl("wakes.jsonl", {
          at: new Date().toISOString(),
          actionId: actionable.actionId,
          queued,
          wake: { woke: false, reason: actionable.kind === "trello_card_moved_to_reschedule" ? "handled_by_queue_worker" : "silent_move" },
          target: null,
        });
      }
    }
    send(res, 200, "ok");
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`trello bridge listening on 0.0.0.0:${PORT}`);
  console.log("local callback path: /trello?token=[redacted]");

  if (TRELLO_API_KEY && TRELLO_API_TOKEN) {
    pollTrelloFallback()
      .then((count) => console.log(`trello fallback poll complete unseen=${count}`))
      .catch((error) => appendJsonl("errors.jsonl", { at: new Date().toISOString(), source: "trello-poll-fallback", error: error?.message || String(error) }));
    setInterval(() => {
      pollTrelloFallback().catch((error) =>
        appendJsonl("errors.jsonl", { at: new Date().toISOString(), source: "trello-poll-fallback", error: error?.message || String(error) }),
      );
    }, 60_000).unref();
  } else {
    console.warn(
      "WARNING: trello fallback poll DISABLED — missing TRELLO_API_KEY/TRELLO_API_TOKEN. " +
        "Webhook misses will not be recovered (cards can get stuck mid-transition). Check /home/deploy/openclaw/.env.",
    );
    appendJsonl("errors.jsonl", {
      at: new Date().toISOString(),
      source: "trello-bridge-startup",
      error: "fallback poll disabled: missing Trello API credentials",
    });
  }

  // Re-attempt undelivered wakes regardless of poll/creds state — a wake only needs
  // the hook, not Trello API creds, and webhook-path wakes can fail with no poll running.
  const wakeRetryMs = Number(process.env.TRELLO_BRIDGE_WAKE_RETRY_MS || 60_000);
  setInterval(() => {
    retryFailedWakes().catch((error) =>
      appendJsonl("errors.jsonl", { at: new Date().toISOString(), source: "wake-retry", error: error?.message || String(error) }),
    );
  }, wakeRetryMs).unref();

  if (process.env.GOG_KEYRING_PASSWORD) {
    gogAuthHealthCheck();
    gogHealthInterval = setInterval(gogAuthHealthCheck, GOG_HEALTH_CHECK_MS).unref();
  }

  const watcherPath = process.env.TRELLO_PIPELINE_DRIVE_SYNC_WATCHER || path.join(__dirname, "drive_sync_watcher.mjs");
  if (fs.existsSync(watcherPath)) {
    const watcher = spawn(process.execPath, [watcherPath], {
      cwd: __dirname,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    watcher.stdout.on("data", (chunk) => process.stdout.write(`[drive-sync] ${chunk}`));
    watcher.stderr.on("data", (chunk) => process.stderr.write(`[drive-sync] ${chunk}`));
    watcher.unref();
  }
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
