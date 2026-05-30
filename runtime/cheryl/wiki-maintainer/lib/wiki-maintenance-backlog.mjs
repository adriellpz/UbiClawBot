import { readdir } from "node:fs/promises";
import path from "node:path";
import { readCompletionRegistry, listInScopeWikiPages, shouldSkipWikiPage } from "./wiki-log-registry.mjs";
import { listPendingSources } from "./ingested-sources-registry.mjs";

const BUCKET_PRIORITY = [
  "runbooks",
  "workflows",
  "job-search",
  "personal",
  "projects",
  "reports",
];

function bucketRank(pageRel) {
  const bucket = pageRel.split("/")[1] ?? "";
  const idx = BUCKET_PRIORITY.indexOf(bucket);
  return idx === -1 ? BUCKET_PRIORITY.length : idx;
}

function reportsSubfolderSort(pageRel) {
  const parts = pageRel.split("/");
  if (parts[1] !== "reports" || parts.length < 4) return "";
  return parts[2];
}

export async function listMaintenanceBacklog(vaultRoot, { limit = 5 } = {}) {
  const logPath = path.join(vaultRoot, "wiki", "log.md");
  let registry;
  try {
    registry = new Set((await readCompletionRegistry(logPath)).map((e) => e.wikiPath));
  } catch {
    registry = new Set();
  }

  const wikiDir = path.join(vaultRoot, "wiki");
  const candidates = [];

  async function walk(dir, relBase) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = `${relBase}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), rel);
      } else if (entry.name.endsWith(".md") && !shouldSkipWikiPage(rel) && !registry.has(rel)) {
        candidates.push(rel);
      }
    }
  }

  try {
    await walk(wikiDir, "wiki");
  } catch {
    return [];
  }

  candidates.sort((a, b) => {
    const br = bucketRank(a) - bucketRank(b);
    if (br !== 0) return br;
    const sub = reportsSubfolderSort(b).localeCompare(reportsSubfolderSort(a));
    if (sub !== 0) return sub;
    return a.localeCompare(b);
  });

  return candidates.slice(0, limit);
}

export async function listRawInputDrops(vaultRoot) {
  const inbox = path.join(vaultRoot, "raw-input");
  const drops = [];
  try {
    const entries = await readdir(inbox, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        drops.push(`raw-input/${entry.name}`);
      }
    }
  } catch {
    // empty inbox
  }
  return drops.sort();
}

export async function assessIdleConditions(vaultRoot) {
  const rawInput = await listRawInputDrops(vaultRoot);
  const pendingSources = await listPendingSources(vaultRoot);
  const backlog = await listMaintenanceBacklog(vaultRoot, { limit: 1 });
  const logPath = path.join(vaultRoot, "wiki", "log.md");
  let registryComplete = false;
  try {
    const registry = await readCompletionRegistry(logPath);
    const registryPaths = new Set(registry.map((e) => e.wikiPath));
    const inScope = await listInScopeWikiPages(vaultRoot);
    registryComplete = inScope.every((p) => registryPaths.has(p));
  } catch {
    registryComplete = false;
  }

  const idle =
    rawInput.length === 0 &&
    pendingSources.length === 0 &&
    backlog.length === 0 &&
    registryComplete;

  return {
    idle,
    rawInputEmpty: rawInput.length === 0,
    sourcesIngested: pendingSources.length === 0,
    registryComplete,
    pendingSources,
    rawInput,
  };
}
