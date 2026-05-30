#!/usr/bin/env node
/**
 * One-time: delete legacy native "Next steps" checklists from open board cards.
 * Skips Done list and Trello-closed (archived) cards.
 *
 * Usage:
 *   node scripts/manual/remove_next_steps_checklists.mjs [--dry-run]
 *
 * Requires TRELLO_API_KEY + TRELLO_API_TOKEN (or trello_bridge/.env on droplet).
 */
import fs from "node:fs";

import { planNextStepsRemoval } from "./remove_next_steps_checklists_logic.mjs";

const bridgeEnv = process.env.TRELLO_BRIDGE_ENV || "/home/node/.openclaw/workspace/trello_bridge/.env";
if (fs.existsSync(bridgeEnv)) {
  for (const line of fs.readFileSync(bridgeEnv, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

const key = process.env.TRELLO_API_KEY;
const token = process.env.TRELLO_API_TOKEN;
const board = process.env.TRELLO_BOARD_ID || "69f96aafc342ad1c89f48e0c";
const dryRun = process.argv.includes("--dry-run");
if (!key || !token) throw new Error("Missing TRELLO_API_KEY/TRELLO_API_TOKEN");

async function trello(method, path, body) {
  const separator = path.includes("?") ? "&" : "?";
  const response = await fetch(
    `https://api.trello.com/1/${path}${separator}key=${encodeURIComponent(key)}&token=${encodeURIComponent(token)}`,
    {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const lists = await trello(
    "GET",
    `boards/${board}/lists?cards=open&card_fields=id,name,closed,idList&cards_checklists=all`,
  );

  const entries = [];
  for (const list of lists) {
    for (const card of list.cards || []) {
      entries.push({
        card,
        listName: list.name,
        checklists: card.checklists || [],
      });
    }
  }

  const plan = planNextStepsRemoval(entries);
  const report = { dryRun, deleted: [], skipped: plan.skipped, errors: [] };

  for (const item of plan.toDelete) {
    if (dryRun) {
      report.deleted.push({ ...item, dryRun: true });
      continue;
    }
    try {
      await trello("DELETE", `checklists/${item.checklistId}`);
      report.deleted.push(item);
    } catch (error) {
      report.errors.push({ ...item, error: error.message });
    }
  }

  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
