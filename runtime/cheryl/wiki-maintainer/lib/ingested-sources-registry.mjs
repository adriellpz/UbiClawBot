import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INGESTED_LOG = "sources/ingested.log";

function normalizeSourcePath(relPath) {
  return relPath.replace(/\\/g, "/").replace(/^\.\//, "");
}

export async function readIngestedPaths(vaultRoot) {
  const logPath = path.join(vaultRoot, INGESTED_LOG);
  try {
    const content = await readFile(logPath, "utf8");
    return content
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

export async function markSourceIngested(vaultRoot, sourceRelPath) {
  const normalized = normalizeSourcePath(sourceRelPath);
  const ingested = new Set(await readIngestedPaths(vaultRoot));
  ingested.add(normalized);
  const logPath = path.join(vaultRoot, INGESTED_LOG);
  await writeFile(logPath, `${[...ingested].sort().join("\n")}\n`, "utf8");
}

export async function listPendingSources(vaultRoot) {
  const ingested = new Set(await readIngestedPaths(vaultRoot));
  const sourcesDir = path.join(vaultRoot, "sources");
  const pending = [];

  async function walk(dir, relBase) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "assets" || entry.name === "ingested.log") continue;
      const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs, rel);
      } else if (entry.name.endsWith(".md")) {
        const normalized = normalizeSourcePath(rel);
        if (!ingested.has(normalized)) pending.push(normalized);
      }
    }
  }

  try {
    await walk(sourcesDir, "sources");
  } catch {
    // no sources tree
  }
  return pending.sort();
}
