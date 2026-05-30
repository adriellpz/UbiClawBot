import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const REGISTRY_HEADING = /^## Completion registry\s*$/im;
const CHRONICLE_HEADING = /^## Chronicle\s*$/im;

/** Paths that must never appear in the completion registry backlog. */
export function isExcludedRegistryPath(wikiRelPath) {
  const normalized = wikiRelPath.replace(/\\/g, "/");
  if (normalized === "wiki/log.md" || normalized === "wiki/index.md") return true;
  if (normalized.startsWith("wiki/openclaw-docs/")) return true;
  if (normalized.startsWith("wiki/sources/")) return true;
  if (/-index\.md$/i.test(normalized)) return true;
  return false;
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

function parseRegistryLines(registryIntro) {
  const entries = [];
  for (const line of registryIntro.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tab = trimmed.indexOf("\t");
    if (tab === -1) continue;
    const wikiPath = trimmed.slice(0, tab).trim();
    const touch = trimmed.slice(tab + 1).trim();
    if (!wikiPath.startsWith("wiki/") || !touch) continue;
    if (isExcludedRegistryPath(wikiPath)) continue;
    entries.push({ wikiPath, touch, line: trimmed });
  }
  return entries;
}

function rebuildRegistryIntro(originalIntro, keptLines) {
  const out = [];
  for (const line of originalIntro.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("wiki/") && trimmed.includes("\t")) {
      if (keptLines.has(trimmed)) out.push(line);
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * Remove completion registry lines where page mtime > curator touch.
 * Chronicle section is never modified.
 */
export async function invalidateStaleLogEntries(logPath, vaultRoot) {
  const content = await readFile(logPath, "utf8");
  const { prefix, registryIntro, chronicleAndRest } = parseLogSections(content);
  const entries = parseRegistryLines(registryIntro);
  const removed = [];
  const kept = new Set();

  for (const entry of entries) {
    const abs = path.join(vaultRoot, entry.wikiPath);
    let stale = false;
    try {
      const { mtimeMs } = await stat(abs);
      const touchMs = Date.parse(entry.touch);
      if (Number.isFinite(touchMs) && mtimeMs > touchMs) {
        stale = true;
      }
    } catch {
      // missing file — keep entry
    }
    if (stale) {
      removed.push(entry.wikiPath);
    } else {
      kept.add(entry.line);
    }
  }

  if (removed.length === 0) {
    return { removed };
  }

  const newRegistryIntro = rebuildRegistryIntro(registryIntro, kept);
  const registryGap = newRegistryIntro.endsWith("\n") ? "" : "\n";
  const rebuilt = `${prefix}## Completion registry${newRegistryIntro}${registryGap}${chronicleAndRest}`;
  await writeFile(logPath, rebuilt, "utf8");
  return { removed };
}
