import { readFile, stat, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isExcludedRegistryPath } from "./wiki-log-preflight.mjs";

const REGISTRY_HEADING = /^## Completion registry\s*$/im;
const CHRONICLE_HEADING = /^## Chronicle\s*$/im;

/** Curator touch timestamp from the page file mtime (matches preflight invalidation). */
export function formatCuratorTouchFromMtime(mtimeMs) {
  return new Date(Math.ceil(mtimeMs)).toISOString();
}

function parseLogSections(content) {
  const registryMatch = content.match(REGISTRY_HEADING);
  const chronicleMatch = content.match(CHRONICLE_HEADING);
  if (!registryMatch || registryMatch.index === undefined) {
    throw new Error("wiki log missing ## Completion registry section");
  }
  if (!chronicleMatch || chronicleMatch.index === undefined) {
    throw new Error("wiki log missing ## Chronicle section");
  }
  const registryStart = registryMatch.index + registryMatch[0].length;
  const chronicleStart = chronicleMatch.index;
  if (chronicleStart <= registryStart) {
    throw new Error("wiki log chronicle must follow completion registry");
  }
  return {
    prefix: content.slice(0, registryMatch.index),
    registryIntro: content.slice(registryStart, chronicleStart),
    chronicleAndRest: content.slice(chronicleStart),
  };
}

function rebuildRegistryIntro(originalIntro, entryLineByPath) {
  const out = [];
  const seen = new Set();
  for (const line of originalIntro.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("wiki/") && trimmed.includes("\t")) {
      const wikiPath = trimmed.slice(0, trimmed.indexOf("\t")).trim();
      if (entryLineByPath.has(wikiPath)) {
        out.push(entryLineByPath.get(wikiPath));
        seen.add(wikiPath);
      }
      continue;
    }
    out.push(line);
  }
  for (const [wikiPath, line] of entryLineByPath) {
    if (!seen.has(wikiPath)) out.push(line);
  }
  return out.join("\n");
}

export function parseCompletionRegistry(content) {
  const registryMatch = content.match(REGISTRY_HEADING);
  const chronicleMatch = content.match(CHRONICLE_HEADING);
  if (!registryMatch || !chronicleMatch) return [];
  const registryStart = registryMatch.index + registryMatch[0].length;
  const registryIntro = content.slice(registryStart, chronicleMatch.index);
  const entries = [];
  for (const line of registryIntro.split("\n")) {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const wikiPath = trimmed.slice(0, tab).trim();
    const touch = trimmed.slice(tab + 1).trim();
    if (!wikiPath.startsWith("wiki/") || !touch) continue;
    if (isExcludedRegistryPath(wikiPath)) continue;
    entries.push({ wikiPath, touch });
  }
  return entries;
}

export async function readCompletionRegistry(logPath) {
  const content = await readFile(logPath, "utf8");
  return parseCompletionRegistry(content);
}

export function shouldSkipWikiPage(relPath) {
  const normalized = relPath.replace(/\\/g, "/");
  if (!normalized.startsWith("wiki/") || !normalized.endsWith(".md")) return true;
  return isExcludedRegistryPath(normalized);
}

export async function listInScopeWikiPages(vaultRoot) {
  const wikiDir = path.join(vaultRoot, "wiki");
  const out = [];

  async function walk(dir, relBase) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.name.endsWith(".md") && !shouldSkipWikiPage(rel)) {
        out.push(rel);
      }
    }
  }

  try {
    await walk(wikiDir, "wiki");
  } catch {
    // no wiki tree
  }
  return out.sort();
}

/**
 * Upsert completion registry lines using each page's current file mtime.
 * Call after all edits/index work so preflight does not treat curator work as operator edits.
 */
export async function upsertCompletionRegistryEntries(logPath, vaultRoot, wikiPaths) {
  const uniquePaths = [
    ...new Set(
      wikiPaths
        .map((p) => p.replace(/\\/g, "/").trim())
        .filter((p) => p.startsWith("wiki/") && !shouldSkipWikiPage(p)),
    ),
  ];
  if (uniquePaths.length === 0) {
    return { updated: [] };
  }

  const content = await readFile(logPath, "utf8");
  const { prefix, registryIntro, chronicleAndRest } = parseLogSections(content);
  const entryLineByPath = new Map();

  for (const line of registryIntro.split("\n")) {
    const trimmed = line.trim();
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const wikiPath = trimmed.slice(0, tab).trim();
    if (!wikiPath.startsWith("wiki/") || isExcludedRegistryPath(wikiPath)) continue;
    entryLineByPath.set(wikiPath, trimmed);
  }

  const updated = [];
  for (const wikiPath of uniquePaths) {
    const abs = path.join(vaultRoot, wikiPath);
    const { mtimeMs } = await stat(abs);
    const touch = formatCuratorTouchFromMtime(mtimeMs);
    entryLineByPath.set(wikiPath, `${wikiPath}\t${touch}`);
    updated.push(wikiPath);
  }

  const newRegistryIntro = rebuildRegistryIntro(registryIntro, entryLineByPath);
  const registryGap = newRegistryIntro.endsWith("\n") ? "" : "\n";
  const rebuilt = `${prefix}## Completion registry${newRegistryIntro}${registryGap}${chronicleAndRest}`;
  await writeFile(logPath, rebuilt, "utf8");
  return { updated };
}

export async function appendWikiChronicle(logPath, { eventType = "maintenance", touched = [], at = new Date() } = {}) {
  const content = await readFile(logPath, "utf8");
  const chronicleMatch = content.match(CHRONICLE_HEADING);
  if (!chronicleMatch || chronicleMatch.index === undefined) {
    throw new Error("wiki log missing ## Chronicle section");
  }

  const iso = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  const count = touched.length;
  const entry = `\n## [${iso}] ${eventType} | ${count} page${count === 1 ? "" : "s"}\n${touched.map((p) => `- touched: ${p}`).join("\n")}\n`;
  const insertAt = chronicleMatch.index + chronicleMatch[0].length;
  const updated = `${content.slice(0, insertAt)}${entry}${content.slice(insertAt)}`;
  await writeFile(logPath, updated, "utf8");
}
