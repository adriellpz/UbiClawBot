import fs from "node:fs";
import path from "node:path";

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function markHandled(stateDir, id) {
  const file = path.join(stateDir, "actionable_handled_ids.json");
  const handled = new Set(readJson(file, []));
  handled.add(id);
  writeJson(file, [...handled].slice(-3000));
}

function failureRecord(stateDir, actionId) {
  const file = path.join(stateDir, "handler_failures.json");
  return readJson(file, {})[actionId] || null;
}

function recordFailure(stateDir, actionId, detail) {
  const file = path.join(stateDir, "handler_failures.json");
  const failures = readJson(file, {});
  const previous = failures[actionId] || { count: 0 };
  failures[actionId] = { count: previous.count + 1, lastAt: new Date().toISOString(), ...detail };
  const keys = Object.keys(failures);
  if (keys.length > 500) for (const key of keys.slice(0, keys.length - 500)) delete failures[key];
  writeJson(file, failures);
}

function clearFailure(stateDir, actionId) {
  const file = path.join(stateDir, "handler_failures.json");
  const failures = readJson(file, {});
  if (failures[actionId]) { delete failures[actionId]; writeJson(file, failures); }
}

const MAX_HANDLER_ATTEMPTS = Number(process.env.TRELLO_PIPELINE_MAX_HANDLER_ATTEMPTS || 5);

export async function dispatch(entry, handlerMap, { getCard, stateDir }) {
  const card = entry.cardId ? await getCard(entry.cardId).catch(() => null) : null;

  if (card?.closed) {
    markHandled(stateDir, entry.actionId);
    return;
  }

  const handler = handlerMap[entry.kind];
  if (!handler || !card) {
    markHandled(stateDir, entry.actionId);
    return;
  }

  const previous = failureRecord(stateDir, entry.actionId);
  if (previous && previous.count >= MAX_HANDLER_ATTEMPTS) {
    markHandled(stateDir, entry.actionId);
    return;
  }

  const ctx = { fromListName: entry.fromListName, actionId: entry.actionId };
  const result = await handler.run(card, ctx);

  if (result.ok) {
    clearFailure(stateDir, entry.actionId);
    markHandled(stateDir, entry.actionId);
  } else {
    recordFailure(stateDir, entry.actionId, result);
  }
}
