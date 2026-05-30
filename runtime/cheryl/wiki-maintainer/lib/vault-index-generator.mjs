import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { shouldSkipWikiPage } from "./wiki-log-registry.mjs";

export function shouldSkipIndexTree(relPath) {
  if (relPath === "raw-input" || relPath.startsWith("raw-input/")) return true;
  // Legacy vault-root sources/ (superseded by wiki/sources/) — never index.
  if (relPath === "sources" || relPath.startsWith("sources/")) return true;
  if (relPath.startsWith("_superseded-sources-")) return true;
  return false;
}

export function extractBlurb(markdown) {
  let body = markdown.replace(/^\uFEFF/, "");
  if (body.startsWith("---")) {
    const end = body.indexOf("---", 3);
    if (end !== -1) body = body.slice(end + 3);
  }
  const lines = body.split("\n");
  let pastTitle = false;
  const blurbLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!pastTitle) {
      if (!trimmed) continue;
      if (trimmed.startsWith("#")) {
        pastTitle = true;
      }
      continue;
    }
    if (!trimmed) {
      if (blurbLines.length) break;
      continue;
    }
    if (trimmed.startsWith("#")) break;
    blurbLines.push(trimmed);
  }
  if (!blurbLines.length) return "";
  const oneLine = blurbLines
    .join(" ")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\*+/g, "");
  return oneLine.length > 120 ? `${oneLine.slice(0, 117)}…` : oneLine;
}

function wikiLinkTarget(relPath) {
  return relPath.replace(/^wiki\//, "").replace(/\.md$/i, "");
}

function folderIndexName(folderRel) {
  const base = path.posix.basename(folderRel);
  return `${base}-index.md`;
}

async function collectWikiPages(wikiDir, relBase = "wiki") {
  const pages = [];
  const entries = await readdir(wikiDir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = `${relBase}/${entry.name}`;
    if (entry.isDirectory()) {
      if (shouldSkipIndexTree(rel.replace(/^wiki\/?/, ""))) continue;
      pages.push(...(await collectWikiPages(path.join(wikiDir, entry.name), rel)));
    } else if (entry.name.endsWith(".md") && !shouldSkipWikiPage(rel)) {
      pages.push(rel);
    }
  }
  return pages;
}

function groupPagesByFolder(pages) {
  const folders = new Map();
  for (const page of pages) {
    const dir = path.posix.dirname(page);
    if (!folders.has(dir)) folders.set(dir, []);
    folders.get(dir).push(page);
  }
  return folders;
}

async function buildFolderIndexBody(folderRel, pageRels, vaultRoot) {
  const lines = [`# ${path.posix.basename(folderRel)} index`, ""];
  for (const pageRel of pageRels.sort()) {
    const content = await readFile(path.join(vaultRoot, pageRel), "utf8");
    const blurb = extractBlurb(content) || "(no summary)";
    const slug = path.posix.basename(pageRel, ".md");
    lines.push(`- [[${slug}]] — ${blurb}`);
  }
  lines.push("");
  return lines.join("\n");
}

async function buildMasterIndexBody(pages, vaultRoot, generatedAt) {
  const lines = ["# Wiki master index", "", `Generated: ${generatedAt}`, ""];
  const topBuckets = new Map();

  for (const pageRel of pages.sort()) {
    const parts = pageRel.split("/");
    const bucket = parts[1] ?? "";
    const subfolder = parts.length > 3 ? parts[2] : null;
    if (!topBuckets.has(bucket)) topBuckets.set(bucket, new Map());
    const subs = topBuckets.get(bucket);
    const key = subfolder ?? "";
    if (!subs.has(key)) subs.set(key, []);
    subs.get(key).push(pageRel);
  }

  for (const [bucket, subs] of [...topBuckets.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`## ${bucket}/`);
    const folderIndex = `wiki/${bucket}/${folderIndexName(`wiki/${bucket}`)}`;
    lines.push(`- [[${wikiLinkTarget(folderIndex)}]] — folder catalog`);
    for (const [sub, subPages] of [...subs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (sub) lines.push(`### ${sub}/`);
      for (const pageRel of subPages) {
        const content = await readFile(path.join(vaultRoot, pageRel), "utf8");
        const blurb = extractBlurb(content) || "(no summary)";
        lines.push(`- [[${wikiLinkTarget(pageRel)}]] — ${blurb}`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function folderMatchesTouched(folderRel, touchedFolders) {
  if (!touchedFolders?.length) return true;
  return touchedFolders.some(
    (t) => folderRel === t || folderRel.startsWith(`${t}/`) || t.startsWith(`${folderRel}/`),
  );
}

export async function generateVaultIndexes(vaultRoot, { generatedAt, folders: touchedFolders } = {}) {
  const results = [];
  const wikiDir = path.join(vaultRoot, "wiki");
  let pages;
  try {
    pages = await collectWikiPages(wikiDir);
  } catch {
    return results;
  }

  const byFolder = groupPagesByFolder(pages);
  for (const [folderRel, pageRels] of byFolder.entries()) {
    if (!folderMatchesTouched(folderRel, touchedFolders)) continue;
    const indexRel = `${folderRel}/${folderIndexName(folderRel)}`;
    const indexAbs = path.join(vaultRoot, indexRel);
    await mkdir(path.dirname(indexAbs), { recursive: true });
    const body = await buildFolderIndexBody(folderRel, pageRels, vaultRoot);
    await writeFile(indexAbs, body, "utf8");
    results.push({ path: indexRel.replace(/\\/g, "/") });
  }

  if (!touchedFolders?.length) {
    const masterRel = "wiki/index.md";
    const masterBody = await buildMasterIndexBody(pages, vaultRoot, generatedAt ?? new Date().toISOString());
    await mkdir(path.dirname(path.join(vaultRoot, masterRel)), { recursive: true });
    await writeFile(path.join(vaultRoot, masterRel), masterBody, "utf8");
    results.push({ path: masterRel });
  }

  return results;
}
