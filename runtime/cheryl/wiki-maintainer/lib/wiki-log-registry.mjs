import { readFile, writeFile } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { isExcludedRegistryPath } from "./wiki-log-preflight.mjs";

const REGISTRY_HEADING = /^## Completion registry\s*$/im;
const CHRONICLE_HEADING = /^## Chronicle\s*$/im;

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
