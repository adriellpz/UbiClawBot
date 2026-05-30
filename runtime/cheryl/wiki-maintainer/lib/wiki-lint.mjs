import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONTRADICTION_CALLOUT = "> **Contradiction:**";

export function detectContradictionPair(contentA, contentB) {
  const claimA = contentA.match(/CLAIM:(.+)/)?.[1]?.trim();
  const claimB = contentB.match(/CLAIM:(.+)/)?.[1]?.trim();
  if (!claimA || !claimB) return null;
  if (claimA === claimB) return null;
  return { claimA, claimB };
}

export async function createContradictionRecord(vaultRoot, { slug, pageA, pageB, claimA, claimB, findings }) {
  const dir = path.join(vaultRoot, "wiki", "contradictions");
  await mkdir(dir, { recursive: true });
  const recordRel = `wiki/contradictions/${slug}.md`;
  const body = `# Contradiction: ${slug}

${CONTRADICTION_CALLOUT} [[${pageA}]] says "${claimA}"; [[${pageB}]] says "${claimB}".

## Findings

${findings}

## Recommended resolution

Merge claims after operator review.
`;
  await writeFile(path.join(vaultRoot, recordRel), body, "utf8");
  return recordRel;
}

export async function addContradictionCallout(pagePath, calloutLine) {
  const content = await readFile(pagePath, "utf8");
  if (content.includes(CONTRADICTION_CALLOUT)) return false;
  const next = `${calloutLine}\n\n${content}`;
  await writeFile(pagePath, next, "utf8");
  return true;
}

export async function runFullWikiLint(vaultRoot, { limit = 5 } = {}) {
  const wikiDir = path.join(vaultRoot, "wiki");
  const { listInScopeWikiPages } = await import("./wiki-log-registry.mjs");
  const pages = await listInScopeWikiPages(vaultRoot);
  const contradictions = [];

  for (let i = 0; i < pages.length && contradictions.length < limit; i++) {
    for (let j = i + 1; j < pages.length && contradictions.length < limit; j++) {
      const a = path.join(vaultRoot, pages[i]);
      const b = path.join(vaultRoot, pages[j]);
      const contentA = await readFile(a, "utf8");
      const contentB = await readFile(b, "utf8");
      const pair = detectContradictionPair(contentA, contentB);
      if (!pair) continue;
      const slug = `${path.basename(pages[i], ".md")}-vs-${path.basename(pages[j], ".md")}`.slice(0, 80);
      const recordRel = await createContradictionRecord(vaultRoot, {
        slug,
        pageA: pages[i].replace(/^wiki\//, "").replace(/\.md$/, ""),
        pageB: pages[j].replace(/^wiki\//, "").replace(/\.md$/, ""),
        claimA: pair.claimA,
        claimB: pair.claimB,
        findings: `Detected conflicting CLAIM markers during full wiki lint.`,
      });
      await addContradictionCallout(a, `${CONTRADICTION_CALLOUT} conflicts with [[${pages[j]}]]`);
      await addContradictionCallout(b, `${CONTRADICTION_CALLOUT} conflicts with [[${pages[i]}]]`);
      contradictions.push({ recordRel, pages: [pages[i], pages[j]] });
    }
  }

  return { contradictions, flagged: contradictions.length };
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

function normalizeWikiLinkTarget(target, fromPageRel) {
  const t = target.trim().replace(/\\/g, "/");
  if (t.startsWith("wiki/")) {
    return t.endsWith(".md") ? t : `${t}.md`;
  }
  if (t.includes("/")) {
    return `wiki/${t}.md`.replace(/\/+/g, "/");
  }
  const fromDir = path.posix.dirname(fromPageRel);
  return `${fromDir}/${t}.md`.replace(/\/+/g, "/");
}

function extractWikilinkTargets(content, fromPageRel) {
  const targets = new Set();
  for (const match of content.matchAll(WIKILINK_RE)) {
    targets.add(normalizeWikiLinkTarget(match[1], fromPageRel));
  }
  return targets;
}

function hasRelatedSection(content) {
  const match = content.match(/^## Related\s*$/im);
  if (!match || match.index === undefined) return false;
  const after = content.slice(match.index + match[0].length);
  const nextHeading = after.search(/^## /m);
  const section = nextHeading === -1 ? after : after.slice(0, nextHeading);
  return section.trim().length > 0;
}

export async function runLightWikiLint(pageRel, vaultRoot) {
  const normalizedPage = pageRel.replace(/\\/g, "/");
  const { listInScopeWikiPages } = await import("./wiki-log-registry.mjs");
  const pages = await listInScopeWikiPages(vaultRoot);
  const pageSet = new Set(pages);

  const inbound = new Map(pages.map((p) => [p, new Set()]));
  for (const fromRel of pages) {
    const content = await readFile(path.join(vaultRoot, fromRel), "utf8");
    for (const target of extractWikilinkTargets(content, fromRel)) {
      if (pageSet.has(target) && target !== fromRel) {
        inbound.get(target).add(fromRel);
      }
    }
  }

  const orphans = pages.filter((p) => inbound.get(p).size === 0);
  const pageContent = await readFile(path.join(vaultRoot, normalizedPage), "utf8");
  const missingRelated = !hasRelatedSection(pageContent);

  return { orphans, missingRelated };
}
