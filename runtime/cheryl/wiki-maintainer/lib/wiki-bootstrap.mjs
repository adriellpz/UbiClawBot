import { access, copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { mapDocsFileToWiki, mapWikiRootOpsFile, shouldSkipDocsPath } from "./docs-to-wiki-mapping.mjs";
import { ensureWikiLayout } from "./wiki-layout.mjs";

export const MARCOS_RULEBOOK_FILES = ["master.md", "scope-rules.md", "nightly-prompt.md"];

async function walkDocs(root, relBase = "") {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const rel = relBase ? `${relBase}/${entry.name}` : entry.name;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkDocs(abs, rel)));
    } else {
      files.push({ rel: `Docs/${rel}`, abs });
    }
  }
  return files;
}

async function fileExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function copyOrMerge({ fromAbs, toAbs, toRel, dryRun }) {
  if (dryRun) {
    return { action: "copy", to: toRel };
  }

  await mkdir(path.dirname(toAbs), { recursive: true });
  if (await fileExists(toAbs)) {
    const existing = await readFile(toAbs, "utf8");
    const incoming = await readFile(fromAbs, "utf8");
    await writeFile(toAbs, `${existing.trimEnd()}\n\n---\n\n${incoming.trimEnd()}\n`, "utf8");
    return { action: "merge", to: toRel };
  }

  await copyFile(fromAbs, toAbs);
  return { action: "copy", to: toRel };
}

export async function bootstrapWiki({
  sourceDocsRoot,
  vaultRoot,
  dryRun = false,
  marcosWorkspaceRoot,
}) {
  if (!dryRun) {
    await ensureWikiLayout(vaultRoot);
  }

  const entries = [];
  const docsFiles = await walkDocs(sourceDocsRoot);

  for (const { rel, abs } of docsFiles) {
    if (shouldSkipDocsPath(rel)) continue;
    const mapped = mapDocsFileToWiki(rel);
    if (!mapped || mapped.skipped) continue;

    const fileName = path.basename(rel);
    const destRel = path.posix.join(mapped.destDir, fileName);
    const destAbs = path.join(vaultRoot, destRel);
    const result = await copyOrMerge({ fromAbs: abs, toAbs: destAbs, toRel: destRel, dryRun });
    entries.push({ from: rel, to: destRel, action: result.action });
  }

  if (marcosWorkspaceRoot) {
    for (const name of MARCOS_RULEBOOK_FILES) {
      const fromAbs = path.join(marcosWorkspaceRoot, name);
      const destRel = path.posix.join("wiki", "runbooks", "marcos", name);
      const destAbs = path.join(vaultRoot, destRel);
      if (await fileExists(fromAbs)) {
        const result = await copyOrMerge({ fromAbs, toAbs: destAbs, toRel: destRel, dryRun });
        entries.push({ from: path.join("marcos", name), to: destRel, action: result.action });
      }
    }
    const auditFrom = path.join(marcosWorkspaceRoot, "audit-2026.md");
    if (await fileExists(auditFrom)) {
      const destRel = path.posix.join("wiki", "reports", "repo-maintenance", "audit-2026.md");
      const destAbs = path.join(vaultRoot, destRel);
      const result = await copyOrMerge({
        fromAbs: auditFrom,
        toAbs: destAbs,
        toRel: destRel,
        dryRun,
      });
      entries.push({ from: "marcos/audit-2026.md", to: destRel, action: result.action });
    }
  }

  return { dryRun, entries };
}
