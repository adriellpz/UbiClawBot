import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { listPendingSources, markSourceIngested } from "./ingested-sources-registry.mjs";
import { downloadSourceAssets } from "./source-asset-downloader.mjs";

function extractTitle(markdown, fallback) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

function summaryWikiRel(sourceRel) {
  const base = path.posix.basename(sourceRel, ".md");
  return `wiki/reports/${base}.md`;
}

function blurbFromSource(markdown) {
  const lines = markdown.split("\n");
  const body = lines.filter((line) => !line.startsWith("#") && !/^!\[/.test(line.trim()));
  const text = body.join(" ").replace(/\s+/g, " ").trim();
  return text || "Summary from raw source ingest.";
}

export async function ingestOnePendingSource(vaultRoot, { fetchImpl } = {}) {
  const pending = await listPendingSources(vaultRoot);
  if (!pending.length) {
    return { didWork: false, pending };
  }

  const sourceRel = pending[0];
  const sourcePath = path.join(vaultRoot, sourceRel);
  const markdown = await readFile(sourcePath, "utf8");

  await downloadSourceAssets(sourcePath, vaultRoot, { fetchImpl });

  const title = extractTitle(markdown, path.posix.basename(sourceRel, ".md"));
  const summaryRel = summaryWikiRel(sourceRel);
  const summaryPath = path.join(vaultRoot, summaryRel);
  await mkdir(path.dirname(summaryPath), { recursive: true });
  await writeFile(
    summaryPath,
    `# ${title}\n\n${blurbFromSource(markdown)}\n`,
    "utf8",
  );

  await markSourceIngested(vaultRoot, sourceRel);

  return {
    didWork: true,
    sourceRel,
    touched: [summaryRel],
    pending: pending.slice(1),
  };
}
