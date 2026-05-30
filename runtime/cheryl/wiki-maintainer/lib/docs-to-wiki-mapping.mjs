const SKIP_PREFIX = "Docs/Exports and Backups/";

const DOCS_PREFIX_RULES = [
  { prefix: "Docs/Reports/", destDir: "wiki/reports", dated: true },
  { prefix: "Docs/Internal Docs/", destDir: "wiki/runbooks" },
  { prefix: "Docs/Job Applications/", destDir: "wiki/job-search" },
  { prefix: "Docs/Personal Admin/", destDir: "wiki/personal" },
  { prefix: "Docs/Projects/", destDir: "wiki/projects" },
];

export function shouldSkipDocsPath(relPath) {
  return relPath.startsWith(SKIP_PREFIX);
}

export function mapDocsFileToWiki(relPath) {
  if (shouldSkipDocsPath(relPath)) {
    return { skipped: true };
  }

  for (const rule of DOCS_PREFIX_RULES) {
    if (!relPath.startsWith(rule.prefix)) continue;

    const remainder = relPath.slice(rule.prefix.length);
    if (rule.dated) {
      const [dateFolder] = remainder.split("/");
      if (/^\d{4}-\d{2}-\d{2}$/.test(dateFolder)) {
        return { destDir: `${rule.destDir}/${dateFolder}` };
      }
    }
    return { destDir: rule.destDir };
  }

  return null;
}

const WIKI_ROOT_OPS_SKIP = new Set(["wiki/README.md"]);

export function mapWikiRootOpsFile(relPath) {
  if (WIKI_ROOT_OPS_SKIP.has(relPath)) return null;
  if (!relPath.startsWith("wiki/") || !relPath.endsWith(".md")) return null;
  const base = relPath.slice("wiki/".length);
  if (base.includes("/")) return null;
  return `wiki/workflows/${base}`;
}
