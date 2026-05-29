import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureWikiLayout,
  wikiLayoutPaths,
} from "../agent-workspace-vault/lib/wiki-layout.mjs";
import {
  mapDocsFileToWiki,
  shouldSkipDocsPath,
  mapWikiRootOpsFile,
} from "../agent-workspace-vault/lib/docs-to-wiki-mapping.mjs";
import { bootstrapWiki, MARCOS_RULEBOOK_FILES } from "../agent-workspace-vault/lib/wiki-bootstrap.mjs";
import {
  applyMappings,
  rewriteVaultPaths,
  scanLegacyPaths,
} from "../agent-workspace-vault/lib/path-rewriter.mjs";
import {
  DEFAULT_PATH_MAPPINGS,
  WIKI_PUBLISH_PATH_MAPPINGS,
} from "../agent-workspace-vault/lib/path-mappings.mjs";
import { readRepoText, repoPathExists, ADR_0003_PATH } from "./docs-contract.helpers.mjs";
import { generateWikiReadme } from "../agent-workspace-vault/lib/hub-generator.mjs";
import { OBSIDIAN_IGNORE_CONTENT } from "../agent-workspace-vault/lib/hygiene-rules.mjs";
import { shouldSkipIndexTree } from "../agent-workspace-vault/lib/vault-index-generator.mjs";
import { generateVaultIndexes } from "../agent-workspace-vault/lib/vault-index-generator.mjs";

test("ensureWikiLayout creates wiki top-level folders and raw-input inbox", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-layout-"));
  const { created } = await ensureWikiLayout(vaultRoot);

  const expected = wikiLayoutPaths();
  assert.deepEqual([...created].sort(), [...expected].sort());

  for (const rel of expected) {
    await access(path.join(vaultRoot, rel));
  }
});

test("ensureWikiLayout is idempotent on second call", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-layout-idem-"));
  const first = await ensureWikiLayout(vaultRoot);
  assert.ok(first.created.length > 0);

  const second = await ensureWikiLayout(vaultRoot);
  assert.deepEqual(second.created, []);

  for (const rel of wikiLayoutPaths()) {
    await access(path.join(vaultRoot, rel));
  }
});

test("mapDocsFileToWiki maps Docs/Reports under wiki/reports with date folder", () => {
  const mapped = mapDocsFileToWiki("Docs/Reports/2026-05-01/daily.md");
  assert.equal(mapped?.destDir, "wiki/reports/2026-05-01");
  assert.notEqual(mapped?.skipped, true);
});

test("mapDocsFileToWiki maps Docs/Internal Docs to wiki/runbooks", () => {
  const mapped = mapDocsFileToWiki("Docs/Internal Docs/playbook.md");
  assert.equal(mapped?.destDir, "wiki/runbooks");
});

test("mapDocsFileToWiki maps job-search, personal, and projects buckets", () => {
  assert.equal(mapDocsFileToWiki("Docs/Job Applications/cv.md")?.destDir, "wiki/job-search");
  assert.equal(mapDocsFileToWiki("Docs/Personal Admin/tax.md")?.destDir, "wiki/personal");
  assert.equal(mapDocsFileToWiki("Docs/Projects/foo.md")?.destDir, "wiki/projects");
});

test("mapWikiRootOpsFile maps loose wiki root markdown to workflows", () => {
  assert.equal(mapWikiRootOpsFile("wiki/cron-map.md"), "wiki/workflows/cron-map.md");
  assert.equal(mapWikiRootOpsFile("wiki/README.md"), null);
});

test("shouldSkipDocsPath skips Exports and Backups tree", () => {
  assert.equal(shouldSkipDocsPath("Docs/Exports and Backups/foo.png"), true);
  assert.equal(shouldSkipDocsPath("Docs/Reports/daily.md"), false);
});

test("bootstrapWiki dryRun leaves fixture tree unchanged", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "wiki-bootstrap-dry-"));
  const docs = path.join(tmp, "Docs");
  const vault = path.join(tmp, "vault");
  await mkdir(path.join(docs, "Reports"), { recursive: true });
  const srcFile = path.join(docs, "Reports", "note.md");
  await writeFile(srcFile, "# note\n");
  const before = await readFile(srcFile, "utf8");

  const manifest = await bootstrapWiki({
    sourceDocsRoot: docs,
    vaultRoot: vault,
    dryRun: true,
  });

  assert.equal(manifest.dryRun, true);
  assert.equal(await readFile(srcFile, "utf8"), before);
  await assert.rejects(access(path.join(vault, "wiki", "reports", "note.md")));
  assert.ok(manifest.entries.some((e) => e.from === "Docs/Reports/note.md" && e.to.includes("wiki/reports")));
});

test("bootstrapWiki copies Docs fixture into wiki layout", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "wiki-bootstrap-copy-"));
  const docs = path.join(tmp, "Docs");
  const vault = path.join(tmp, "vault");
  await mkdir(path.join(docs, "Internal Docs"), { recursive: true });
  await writeFile(path.join(docs, "Internal Docs", "playbook.md"), "# play\n");

  await bootstrapWiki({ sourceDocsRoot: docs, vaultRoot: vault, dryRun: false });

  const dest = path.join(vault, "wiki", "runbooks", "playbook.md");
  await access(dest);
  assert.match(await readFile(dest, "utf8"), /# play/);
});

test("bootstrapWiki dedup merges duplicate destination and records merge", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "wiki-bootstrap-dedup-"));
  const docs = path.join(tmp, "Docs");
  const vault = path.join(tmp, "vault");
  await mkdir(path.join(docs, "Internal Docs"), { recursive: true });
  await writeFile(path.join(docs, "Internal Docs", "playbook.md"), "# first\n");
  await mkdir(path.join(vault, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(vault, "wiki", "runbooks", "playbook.md"), "# existing\n");

  const manifest = await bootstrapWiki({
    sourceDocsRoot: docs,
    vaultRoot: vault,
    dryRun: false,
  });

  const entry = manifest.entries.find(
    (e) => e.from === "Docs/Internal Docs/playbook.md" && e.to === path.join("wiki", "runbooks", "playbook.md"),
  );
  assert.equal(entry?.action, "merge");

  const merged = await readFile(path.join(vault, "wiki", "runbooks", "playbook.md"), "utf8");
  assert.match(merged, /# existing/);
  assert.match(merged, /# first/);
  assert.match(merged, /---/);
});

test("bootstrapWiki places Marcos rulebook under wiki/runbooks/marcos", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "wiki-bootstrap-marcos-"));
  const vault = path.join(tmp, "vault");
  const marcos = path.join(tmp, "marcos");
  await mkdir(marcos, { recursive: true });
  for (const name of MARCOS_RULEBOOK_FILES) {
    await writeFile(path.join(marcos, name), `# ${name}\n`);
  }
  await writeFile(path.join(marcos, "audit-2026.md"), "# audit\n");

  await bootstrapWiki({
    sourceDocsRoot: path.join(tmp, "Docs-empty"),
    vaultRoot: vault,
    dryRun: false,
    marcosWorkspaceRoot: marcos,
  });

  for (const name of MARCOS_RULEBOOK_FILES) {
    await access(path.join(vault, "wiki", "runbooks", "marcos", name));
  }
  await access(path.join(vault, "wiki", "reports", "repo-maintenance", "audit-2026.md"));
});

test("generateWikiReadme does not claim only Ubi writes wiki at runtime", () => {
  const readme = generateWikiReadme();
  assert.doesNotMatch(readme, /only Ubi.*writes to `wiki\//i);
  assert.match(readme, /raw-input/);
});

test("shouldSkipIndexTree skips raw-input and _failed", () => {
  assert.equal(shouldSkipIndexTree("raw-input"), true);
  assert.equal(shouldSkipIndexTree("raw-input/_failed"), true);
  assert.equal(shouldSkipIndexTree("raw-input/ubi-2026-05-30-test.md"), true);
});

test("OBSIDIAN_IGNORE_CONTENT includes raw-input", () => {
  assert.match(OBSIDIAN_IGNORE_CONTENT, /raw-input\//);
});

test("generateVaultIndexes does not index raw-input subtree", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-raw-input-skip-"));
  await mkdir(path.join(root, "raw-input"), { recursive: true });
  await writeFile(path.join(root, "raw-input", "drop.md"), "# drop\n");
  await mkdir(path.join(root, "wiki", "reports"), { recursive: true });
  await writeFile(path.join(root, "wiki", "reports", "note.md"), "# n\n");

  const results = await generateVaultIndexes(root, { generatedAt: "2026-05-29" });
  const paths = new Set(results.map((r) => r.path));
  assert.equal(paths.has("raw-input/raw-input-index.md"), false);
  assert.ok(paths.has("wiki/wiki-index.md"));

  await assert.rejects(readFile(path.join(root, "raw-input", "raw-input-index.md"), "utf8"));
});

test("scanLegacyPaths reports zero Docs hits on rewritten fixture vault", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "wiki-scan-legacy-"));
  const root = path.join(tmp, "agent-vault");
  const skillDir = path.join(root, "ubi", "skills", "wiki-publish");
  await mkdir(skillDir, { recursive: true });
  await mkdir(path.join(root, "cheryl", "skills", "scheduler"), { recursive: true });
  await mkdir(path.join(root, "marcos"), { recursive: true });

  const legacySnippet =
    "Write nightly notes to Docs/Reports/2026-05-01/nightly.md; read Docs/Internal Docs/playbook.md";
  await writeFile(path.join(skillDir, "SKILL.md"), legacySnippet, "utf8");
  await writeFile(
    path.join(root, "cheryl", "skills", "scheduler", "SKILL.md"),
    "Drop handoffs in Docs/Job Applications/cv.md",
    "utf8",
  );
  await writeFile(
    path.join(root, "marcos", "AGENTS.md"),
    "Workspace: `/home/node/.openclaw/workspace-marcos`\nPublish: Docs/Projects/foo.md\n",
    "utf8",
  );

  const wikiMappings = [...WIKI_PUBLISH_PATH_MAPPINGS, ...DEFAULT_PATH_MAPPINGS];
  await rewriteVaultPaths({ root, mappings: wikiMappings });

  const { matches } = await scanLegacyPaths({ root });
  const docsHits = matches.filter((m) => /Docs\//.test(m.text));
  assert.equal(docsHits.length, 0, docsHits.map((m) => `${m.file}:${m.line}`).join("; "));
});

test("path rewriter maps Docs write paths to raw-input", () => {
  const sample = "Write reports to Docs/Reports/nightly.md and read wiki/runbooks/foo.md";
  const { next: out } = applyMappings(sample, WIKI_PUBLISH_PATH_MAPPINGS);
  assert.match(out, /raw-input/);
  assert.doesNotMatch(out, /Docs\/Reports/);
  assert.match(out, /wiki\/runbooks/);
});

test("ADR 0003 raw-input wiki curator doc exists", () => {
  assert.equal(repoPathExists(ADR_0003_PATH), true);
  const adr = readRepoText(ADR_0003_PATH);
  assert.match(adr, /raw input/i);
  assert.match(adr, /wiki curator/i);
});

test("CONTEXT.md defines raw input, wiki curator, and wiki bootstrap", () => {
  const ctx = readRepoText("CONTEXT.md");
  assert.match(ctx, /\*\*raw input\*\*/i);
  assert.match(ctx, /\*\*wiki curator\*\*/i);
  assert.match(ctx, /\*\*wiki bootstrap\*\*/i);
});
