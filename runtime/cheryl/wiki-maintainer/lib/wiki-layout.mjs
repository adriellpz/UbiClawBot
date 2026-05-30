import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const WIKI_TOP_LEVEL = [
  "wiki/reports",
  "wiki/runbooks",
  "wiki/job-search",
  "wiki/personal",
  "wiki/projects",
  "wiki/workflows",
  "wiki/contradictions",
];

const MAINTAINER_SCAFFOLD = [
  "sources",
  "sources/assets",
  "wiki/log.md",
  "sources/ingested.log",
];

/** Empty combined wiki log: completion registry + chronicle (REQ-P0-002). */
export const WIKI_LOG_TEMPLATE = `# Wiki log

## Completion registry

One line per maintained vault document: wiki/path/to/page.md\tcurator-touch-iso8601 (tab-separated).

## Chronicle

Append-only events use ## [iso8601] ingest | source, ## [iso8601] maintenance | N pages, or ## [iso8601] lint | … — each followed by - touched: wiki paths.
`;

function isLayoutFile(rel) {
  return rel.endsWith(".md") || rel.endsWith(".log");
}

function layoutFileContent(rel) {
  return rel === "wiki/log.md" ? WIKI_LOG_TEMPLATE : "";
}

/** Relative vault paths created by ensureWikiLayout. */
export function wikiLayoutPaths() {
  return [
    ...WIKI_TOP_LEVEL,
    "raw-input",
    "raw-input/_failed",
    ...MAINTAINER_SCAFFOLD,
  ];
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function ensureWikiLayout(vaultRoot) {
  const created = [];

  for (const rel of wikiLayoutPaths()) {
    const abs = path.join(vaultRoot, rel);
    if (await exists(abs)) continue;

    if (isLayoutFile(rel)) {
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, layoutFileContent(rel), "utf8");
    } else {
      await mkdir(abs, { recursive: true });
    }
    created.push(rel);
  }

  return { created };
}
