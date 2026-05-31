import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ensureWikiLayout,
  wikiLayoutPaths,
  WIKI_LOG_TEMPLATE,
} from "./runtime/cheryl/wiki-maintainer/lib/wiki-layout.mjs";
import {
  mapDocsFileToWiki,
  shouldSkipDocsPath,
  mapWikiRootOpsFile,
} from "./runtime/cheryl/wiki-maintainer/lib/docs-to-wiki-mapping.mjs";
import { bootstrapWiki, MARCOS_RULEBOOK_FILES } from "./runtime/cheryl/wiki-maintainer/lib/wiki-bootstrap.mjs";
import {
  applyMappings,
  rewriteVaultPaths,
  scanLegacyPaths,
} from "./runtime/cheryl/wiki-maintainer/lib/path-rewriter.mjs";
import {
  DEFAULT_PATH_MAPPINGS,
  WIKI_PUBLISH_PATH_MAPPINGS,
} from "./runtime/cheryl/wiki-maintainer/lib/path-mappings.mjs";
import { readRepoText, repoPathExists, ADR_0003_PATH, readSiblingText, siblingPathExists, siblingVaultTestOptions } from "./docs-contract.helpers.mjs";
import { generateWikiReadme } from "./runtime/cheryl/wiki-maintainer/lib/hub-generator.mjs";
import { OBSIDIAN_IGNORE_CONTENT } from "./runtime/cheryl/wiki-maintainer/lib/hygiene-rules.mjs";
import { shouldSkipIndexTree } from "./runtime/cheryl/wiki-maintainer/lib/vault-index-generator.mjs";
import { generateVaultIndexes } from "./runtime/cheryl/wiki-maintainer/lib/vault-index-generator.mjs";
import {
  invalidateStaleLogEntries,
  isExcludedRegistryPath,
} from "./runtime/cheryl/wiki-maintainer/lib/wiki-log-preflight.mjs";
import { upsertCompletionRegistryEntries } from "./runtime/cheryl/wiki-maintainer/lib/wiki-log-registry.mjs";
import { spawn } from "node:child_process";
import { extractBlurb } from "./runtime/cheryl/wiki-maintainer/lib/vault-index-generator.mjs";
import { markSourceIngested, listPendingSources } from "./runtime/cheryl/wiki-maintainer/lib/ingested-sources-registry.mjs";
import { downloadSourceAssets } from "./runtime/cheryl/wiki-maintainer/lib/source-asset-downloader.mjs";
import {
  getIdleStreak,
  incrementIdleStreak,
  resetIdleStreak,
} from "./runtime/cheryl/wiki-maintainer/lib/curator-idle-streak.mjs";
import {
  listMaintenanceBacklog,
  listRawInputDrops,
  assessIdleConditions,
} from "./runtime/cheryl/wiki-maintainer/lib/wiki-maintenance-backlog.mjs";
import { reindexWikiSearch } from "./runtime/cheryl/wiki-maintainer/lib/wiki-search-index-manager.mjs";
import { runFullWikiLint, runLightWikiLint } from "./runtime/cheryl/wiki-maintainer/lib/wiki-lint.mjs";
import { runCuratorCronTick } from "./runtime/cheryl/wiki-maintainer/lib/curator-cron-tick.mjs";

test("wikiLayoutPaths includes wiki/sources/, wiki/sources/assets/, wiki/log.md, wiki/sources/ingested.log", () => {
  const paths = new Set(wikiLayoutPaths());
  assert.ok(paths.has("wiki/sources"));
  assert.ok(paths.has("wiki/sources/assets"));
  assert.ok(paths.has("wiki/log.md"));
  assert.ok(paths.has("wiki/sources/ingested.log"));
});

test("ensureWikiLayout creates wiki top-level folders and raw-input inbox", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-layout-"));
  const { created } = await ensureWikiLayout(vaultRoot);

  const expected = wikiLayoutPaths();
  assert.deepEqual([...created].sort(), [...expected].sort());

  for (const rel of expected) {
    await access(path.join(vaultRoot, rel));
  }
});

test("seeds wiki/log.md with completion registry + chronicle sections", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-layout-log-"));
  await ensureWikiLayout(vaultRoot);

  const logPath = path.join(vaultRoot, "wiki", "log.md");
  const log = await readFile(logPath, "utf8");

  assert.match(log, /## Completion registry/i);
  assert.match(log, /wiki\/path.*\.md.*\t.*iso8601/i);
  assert.match(log, /## Chronicle/i);
  assert.match(log, /## \[iso8601\]/i);

  const registryBody = log.split(/## Chronicle/i)[0];
  const registryLines = registryBody
    .split("\n")
    .filter((line) => line.startsWith("wiki/") && line.includes("\t"));
  assert.equal(registryLines.length, 0);

  const chronicleBody = log.split(/## Chronicle/i)[1] ?? "";
  const chronicleEvents = chronicleBody.split("\n").filter((line) => /^## \[\d/.test(line));
  assert.equal(chronicleEvents.length, 0);

  const customLog = "# operator log\nwiki/reports/note.md\t2026-05-30T12:00:00Z\n";
  await writeFile(logPath, customLog, "utf8");
  await ensureWikiLayout(vaultRoot);
  assert.equal(await readFile(logPath, "utf8"), customLog);
});

test("seeds empty wiki/sources/ingested.log", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-layout-ingested-"));
  await ensureWikiLayout(vaultRoot);

  const ingestedPath = path.join(vaultRoot, "wiki", "sources", "ingested.log");
  await access(ingestedPath);
  assert.equal(await readFile(ingestedPath, "utf8"), "");

  const customIngested = "wiki/sources/raw/drop.md\n";
  await writeFile(ingestedPath, customIngested, "utf8");
  await ensureWikiLayout(vaultRoot);
  assert.equal(await readFile(ingestedPath, "utf8"), customIngested);
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

  const maintainerPaths = ["wiki/sources", "wiki/sources/assets", "wiki/log.md", "wiki/sources/ingested.log"];
  for (const rel of maintainerPaths) {
    await access(path.join(vaultRoot, rel));
  }
});

test("ensureWikiLayout on sibling vault creates maintainer scaffold", siblingVaultTestOptions(), async () => {
  const vaultRoot = path.resolve(import.meta.dirname, "../agent-workspace-vault");
  await ensureWikiLayout(vaultRoot);

  const maintainerPaths = ["wiki/sources", "wiki/sources/assets", "wiki/log.md", "wiki/sources/ingested.log"];
  for (const rel of maintainerPaths) {
    await access(path.join(vaultRoot, rel));
  }
});

test("sibling vault has no legacy vault-root sources/ trees", siblingVaultTestOptions(), async () => {
  const vaultRoot = path.resolve(import.meta.dirname, "../agent-workspace-vault");
  const legacyRootSources = path.join(vaultRoot, "sources");
  let legacyExists = true;
  try {
    await access(legacyRootSources);
  } catch {
    legacyExists = false;
  }
  assert.equal(legacyExists, false);
});

const WIKI_PUBLISHING_PATH = "agent-workspace-vault/wiki/workflows/wiki-publishing.md";
const WIKI_CURATOR_PATH = "agent-workspace-vault/wiki/workflows/wiki-curator.md";
const RAW_INPUT_PATH = "agent-workspace-vault/wiki/workflows/raw-input.md";
const CHERYL_VAULT_INBOX_SKILL_PATH =
  "agent-workspace-vault/cheryl/skills/cheryl-vault-inbox/SKILL.md";
const WIKI_CURATOR_CRON_JOBS_PATH = "config/live/cron/jobs.json";

test("wiki-publishing schema exists with required headings", siblingVaultTestOptions(), () => {
  assert.equal(siblingPathExists(WIKI_PUBLISHING_PATH), true);
  const doc = readSiblingText(WIKI_PUBLISHING_PATH);
  assert.match(doc, /## Interaction capture/i);
  assert.match(doc, /## Raw input drops/i);
  assert.match(doc, /## Wiki update drops/i);
  assert.match(doc, /## Raw sources/i);
  assert.match(doc, /## Wiki query/i);
  assert.match(doc, /## Producer rules/i);
});

test("wiki-publishing documents RAG exclusion for wiki/sources/ and raw-input/", siblingVaultTestOptions(), () => {
  const doc = readSiblingText(WIKI_PUBLISHING_PATH);
  assert.match(doc, /RAG/i);
  assert.match(doc, /wiki\/sources\//);
  assert.match(doc, /raw-input\//);
});

test("wiki-curator schema exists with required headings", siblingVaultTestOptions(), () => {
  assert.equal(siblingPathExists(WIKI_CURATOR_PATH), true);
  const doc = readSiblingText(WIKI_CURATOR_PATH);
  assert.match(doc, /## Curator cron tick/i);
  assert.match(doc, /## Wiki ingest/i);
  assert.match(doc, /## Wiki maintenance/i);
  assert.match(doc, /## Page format contract/i);
  assert.match(doc, /## Wiki log/i);
  assert.match(doc, /## Sources ingested log/i);
  assert.match(doc, /## Index regeneration/i);
  assert.match(doc, /## NO_REPLY rules/i);
});

test("wiki-curator supersedes legacy raw-input.md filing-clerk pointer", siblingVaultTestOptions(), () => {
  const rawInput = readSiblingText(RAW_INPUT_PATH);
  assert.match(rawInput, /Superseded for filing semantics/i);
  assert.match(rawInput, /\[\[wiki-publishing\]\]/);
  assert.match(rawInput, /\[\[wiki-curator\]\]/);
});

test("vault lib contract suite imports resolve after lib restore", async () => {
  assert.equal(repoPathExists("runtime/cheryl/wiki-maintainer/lib/wiki-layout.mjs"), true);
  assert.equal(repoPathExists("runtime/cheryl/wiki-maintainer/lib/vault-index-generator.mjs"), true);
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-lib-smoke-"));
  await ensureWikiLayout(root);
  const results = await generateVaultIndexes(root, { generatedAt: "2026-05-30" });
  assert.ok(Array.isArray(results));
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
  assert.ok(paths.has("wiki/reports/reports-index.md"));
  assert.ok(paths.has("wiki/index.md"));

  await assert.rejects(readFile(path.join(root, "raw-input", "raw-input-index.md"), "utf8"));
});

test("generateVaultIndexes writes folder index with wikilink and blurb", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-folder-index-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "runbooks", "playbook.md"),
    "# Playbook\n\nOperator runbook for nightly checks.\n",
    "utf8",
  );

  await generateVaultIndexes(root, { generatedAt: "2026-05-30" });

  const index = await readFile(path.join(root, "wiki", "runbooks", "runbooks-index.md"), "utf8");
  assert.match(index, /^# runbooks index/m);
  assert.match(index, /^- \[\[playbook\]\] — Operator runbook for nightly checks\.$/m);
});

test("generateVaultIndexes folders mode skips untouched directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-folders-mode-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "runbooks", "playbook.md"),
    "# Playbook\n\nOriginal runbook blurb.\n",
    "utf8",
  );
  await mkdir(path.join(root, "wiki", "reports"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "reports", "note.md"),
    "# Note\n\nReports folder blurb.\n",
    "utf8",
  );

  await generateVaultIndexes(root, { generatedAt: "2026-05-30" });
  const runbooksBefore = await readFile(
    path.join(root, "wiki", "runbooks", "runbooks-index.md"),
    "utf8",
  );
  assert.match(runbooksBefore, /Original runbook blurb\./);

  await writeFile(
    path.join(root, "wiki", "runbooks", "playbook.md"),
    "# Playbook\n\nUpdated runbook blurb.\n",
    "utf8",
  );

  const results = await generateVaultIndexes(root, {
    generatedAt: "2026-05-30",
    folders: ["wiki/reports"],
  });
  const paths = new Set(results.map((r) => r.path));
  assert.ok(paths.has("wiki/reports/reports-index.md"));
  assert.equal(paths.has("wiki/runbooks/runbooks-index.md"), false);
  assert.equal(paths.has("wiki/index.md"), false);

  const runbooksAfter = await readFile(
    path.join(root, "wiki", "runbooks", "runbooks-index.md"),
    "utf8",
  );
  assert.equal(runbooksAfter, runbooksBefore);
  assert.match(
    await readFile(path.join(root, "wiki", "reports", "reports-index.md"), "utf8"),
    /Reports folder blurb\./,
  );
});

test("generateVaultIndexes writes wiki/index.md with bucket hierarchy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-master-index-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "runbooks", "playbook.md"),
    "# Playbook\n\nRunbook blurb.\n",
    "utf8",
  );
  await mkdir(path.join(root, "wiki", "reports", "2026-05-01"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "reports", "2026-05-01", "daily.md"),
    "# Daily\n\nDaily report summary.\n",
    "utf8",
  );

  await generateVaultIndexes(root, { generatedAt: "2026-05-30" });

  const master = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  assert.match(master, /^# Wiki master index/m);
  assert.match(master, /Generated: 2026-05-30/);
  assert.match(master, /^## reports\//m);
  assert.match(master, /^- \[\[reports\/reports-index\]\] — folder catalog$/m);
  assert.match(master, /^### 2026-05-01\//m);
  assert.match(master, /^- \[\[reports\/2026-05-01\/daily\]\] — Daily report summary\.$/m);
  assert.match(master, /^## runbooks\//m);
  assert.match(master, /^- \[\[runbooks\/runbooks-index\]\] — folder catalog$/m);
  assert.match(master, /^- \[\[runbooks\/playbook\]\] — Runbook blurb\.$/m);
  const reportsPos = master.indexOf("## reports/");
  const runbooksPos = master.indexOf("## runbooks/");
  assert.ok(reportsPos < runbooksPos, "buckets sorted alphabetically");
});

test("generateVaultIndexes excludes openclaw-docs and *-index from catalog", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-catalog-exclusions-"));
  await mkdir(path.join(root, "wiki", "openclaw-docs", "gateway"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "openclaw-docs", "gateway", "doctor.md"),
    "# Doctor\n\nOpenClaw mirror page.\n",
    "utf8",
  );
  await mkdir(path.join(root, "wiki", "reports"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "reports", "note.md"),
    "# Note\n\nIn-scope report blurb.\n",
    "utf8",
  );
  await writeFile(
    path.join(root, "wiki", "reports", "reports-index.md"),
    "# reports index\n\n- [[stale]] — should not appear in regenerated catalog\n",
    "utf8",
  );

  const results = await generateVaultIndexes(root, { generatedAt: "2026-05-30" });
  const paths = new Set(results.map((r) => r.path));
  assert.equal(paths.has("wiki/openclaw-docs/openclaw-docs-index.md"), false);
  assert.equal(paths.has("wiki/openclaw-docs/gateway/gateway-index.md"), false);

  const master = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  assert.doesNotMatch(master, /openclaw-docs/);
  assert.doesNotMatch(master, /Doctor/);
  assert.match(master, /In-scope report blurb\./);

  const reportsIndex = await readFile(path.join(root, "wiki", "reports", "reports-index.md"), "utf8");
  assert.doesNotMatch(reportsIndex, /\[\[stale\]\]/);
  assert.match(reportsIndex, /\[\[note\]\] — In-scope report blurb\./);
  assert.doesNotMatch(reportsIndex, /reports-index/);
});

test("extractBlurb returns one-line summary after title", () => {
  const markdown = `---
tags: [report]
created: 2026-05-01
---

# Weekly Report

First sentence of the blurb.
Second sentence adds detail.
Third wraps up.

## Body

More content here.
`;
  assert.equal(
    extractBlurb(markdown),
    "First sentence of the blurb. Second sentence adds detail. Third wraps up.",
  );
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

test("isExcludedRegistryPath skips openclaw-docs, index pages, and log", () => {
  assert.equal(isExcludedRegistryPath("wiki/openclaw-docs/gateway/doctor.md"), true);
  assert.equal(isExcludedRegistryPath("wiki/reports/reports-index.md"), true);
  assert.equal(isExcludedRegistryPath("wiki/log.md"), true);
  assert.equal(isExcludedRegistryPath("wiki/index.md"), true);
  assert.equal(isExcludedRegistryPath("wiki/runbooks/playbook.md"), false);
  assert.equal(isExcludedRegistryPath("wiki/sources/clipped-article.md"), true);
});

function wikiLogWithRegistryLines(registryLines, chronicleExtra = "") {
  const marker = "## Chronicle";
  const idx = WIKI_LOG_TEMPLATE.indexOf(marker);
  const head = WIKI_LOG_TEMPLATE.slice(0, idx);
  const tail = WIKI_LOG_TEMPLATE.slice(idx);
  const lines = registryLines.length ? `${registryLines.join("\n")}\n\n` : "";
  return `${head}${lines}${tail}${chronicleExtra}`;
}

test("invalidateStaleLogEntries is no-op when mtime <= touch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-log-noop-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  const page = path.join(root, "wiki", "runbooks", "playbook.md");
  await writeFile(page, "# play\n");
  const touch = "2099-01-01T00:00:00.000Z";
  const logPath = path.join(root, "wiki", "log.md");
  const chronicle = "\n## [2026-05-30T13:00:00Z] maintenance | 1 pages\n- touched: wiki/runbooks/playbook.md\n";
  await writeFile(
    logPath,
    wikiLogWithRegistryLines([`wiki/runbooks/playbook.md\t${touch}`], chronicle),
    "utf8",
  );
  const before = await readFile(logPath, "utf8");
  const { removed } = await invalidateStaleLogEntries(logPath, root);
  assert.deepEqual(removed, []);
  assert.equal(await readFile(logPath, "utf8"), before);
});

test("invalidateStaleLogEntries removes entry when mtime > touch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-log-stale-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  const page = path.join(root, "wiki", "runbooks", "playbook.md");
  await writeFile(page, "# play\n");
  const logPath = path.join(root, "wiki", "log.md");
  const touch = "2020-01-01T00:00:00.000Z";
  const chronicle = "\n## [2026-05-30T13:00:00Z] maintenance | 1 pages\n- touched: wiki/runbooks/playbook.md\n";
  await writeFile(
    logPath,
    wikiLogWithRegistryLines([`wiki/runbooks/playbook.md\t${touch}`], chronicle),
    "utf8",
  );
  const { removed } = await invalidateStaleLogEntries(logPath, root);
  assert.deepEqual(removed, ["wiki/runbooks/playbook.md"]);
  const after = await readFile(logPath, "utf8");
  assert.doesNotMatch(after, /wiki\/runbooks\/playbook\.md\t/);
  assert.match(after, /## \[2026-05-30T13:00:00Z\] maintenance/);
});

test("invalidateStaleLogEntries ignores excluded registry paths", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-log-excluded-"));
  await mkdir(path.join(root, "wiki"), { recursive: true });
  const logPath = path.join(root, "wiki", "log.md");
  await writeFile(
    logPath,
    wikiLogWithRegistryLines([
      "wiki/openclaw-docs/foo.md\t2020-01-01T00:00:00.000Z",
      "wiki/reports-index.md\t2020-01-01T00:00:00.000Z",
    ]),
    "utf8",
  );
  const { removed } = await invalidateStaleLogEntries(logPath, root);
  assert.deepEqual(removed, []);
});

test("upsertCompletionRegistryEntries uses file mtime so preflight keeps entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-log-register-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  const page = path.join(root, "wiki", "runbooks", "playbook.md");
  await writeFile(page, "# play\n");
  const logPath = path.join(root, "wiki", "log.md");
  await writeFile(logPath, wikiLogWithRegistryLines([]), "utf8");

  const { updated } = await upsertCompletionRegistryEntries(logPath, root, ["wiki/runbooks/playbook.md"]);
  assert.deepEqual(updated, ["wiki/runbooks/playbook.md"]);

  const { removed } = await invalidateStaleLogEntries(logPath, root);
  assert.deepEqual(removed, []);
});

test("upsertCompletionRegistryEntries replaces hand-written touch with file mtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-log-register-replace-"));
  await mkdir(path.join(root, "wiki", "workflows"), { recursive: true });
  const page = path.join(root, "wiki", "workflows", "wiki-curator.md");
  await writeFile(page, "# curator\n");
  const logPath = path.join(root, "wiki", "log.md");
  await writeFile(
    logPath,
    wikiLogWithRegistryLines(["wiki/workflows/wiki-curator.md\t2026-05-30T14:45:00Z"]),
    "utf8",
  );

  await upsertCompletionRegistryEntries(logPath, root, ["wiki/workflows/wiki-curator.md"]);
  const { removed } = await invalidateStaleLogEntries(logPath, root);
  assert.deepEqual(removed, []);
});

test("wiki-log-register CLI upserts registry from file mtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-log-register-cli-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(root, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await ensureWikiLayout(root);
  const cli = path.resolve(import.meta.dirname, "runtime/cheryl/wiki-maintainer/bin/wiki-log-register.mjs");
  const output = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, root, "wiki/runbooks/playbook.md"],
      { encoding: "utf8" },
    );
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`exit ${code}: ${stdout}`));
      else resolve(stdout);
    });
  });
  assert.match(output, /updated 1 entries/);
  const log = await readFile(path.join(root, "wiki", "log.md"), "utf8");
  assert.match(log, /wiki\/runbooks\/playbook\.md\t/);
});

test("wiki-log-preflight CLI runs against empty registry log", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wiki-log-cli-"));
  await ensureWikiLayout(root);
  const cli = path.resolve(import.meta.dirname, "runtime/cheryl/wiki-maintainer/bin/wiki-log-preflight.mjs");
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, root], { encoding: "utf8" });
    let stdout = "";
    child.stdout.on("data", (c) => {
      stdout += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`exit ${code}: ${stdout}`));
      else resolve(stdout);
    });
  });
  assert.match(output, /no stale registry entries/);
});

test("generate-vault-indexes CLI runs full regeneration", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-index-cli-full-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "runbooks", "playbook.md"),
    "# Playbook\n\nOperator runbook for nightly checks.\n",
    "utf8",
  );
  await mkdir(path.join(root, "wiki", "reports"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "reports", "note.md"),
    "# Note\n\nReports folder blurb.\n",
    "utf8",
  );

  const cli = path.resolve(import.meta.dirname, "runtime/cheryl/wiki-maintainer/bin/generate-vault-indexes.mjs");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", root], { encoding: "utf8" });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`exit ${code}: ${stderr}`));
      else resolve();
    });
  });

  await access(path.join(root, "wiki", "index.md"));
  await access(path.join(root, "wiki", "runbooks", "runbooks-index.md"));
  await access(path.join(root, "wiki", "reports", "reports-index.md"));
  const master = await readFile(path.join(root, "wiki", "index.md"), "utf8");
  assert.match(master, /^# Wiki master index/m);
  const runbooksIndex = await readFile(
    path.join(root, "wiki", "runbooks", "runbooks-index.md"),
    "utf8",
  );
  assert.match(runbooksIndex, /Operator runbook for nightly checks\./);
});

test("generate-vault-indexes CLI --folders mode skips untouched directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "vault-index-cli-folders-"));
  await mkdir(path.join(root, "wiki", "runbooks"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "runbooks", "playbook.md"),
    "# Playbook\n\nOriginal runbook blurb.\n",
    "utf8",
  );
  await mkdir(path.join(root, "wiki", "reports"), { recursive: true });
  await writeFile(
    path.join(root, "wiki", "reports", "note.md"),
    "# Note\n\nReports folder blurb.\n",
    "utf8",
  );

  const cli = path.resolve(import.meta.dirname, "runtime/cheryl/wiki-maintainer/bin/generate-vault-indexes.mjs");
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", root], { encoding: "utf8" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`full regen exit ${code}`));
      else resolve();
    });
  });

  const runbooksBefore = await readFile(
    path.join(root, "wiki", "runbooks", "runbooks-index.md"),
    "utf8",
  );
  assert.match(runbooksBefore, /Original runbook blurb\./);

  await writeFile(
    path.join(root, "wiki", "runbooks", "playbook.md"),
    "# Playbook\n\nUpdated runbook blurb.\n",
    "utf8",
  );

  let output = "";
  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [cli, "--root", root, "--folders", "wiki/reports"],
      { encoding: "utf8" },
    );
    child.stdout.on("data", (c) => {
      output += c;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`folders regen exit ${code}`));
      else resolve();
    });
  });

  assert.match(output, /wiki\/reports\/reports-index\.md/);
  assert.doesNotMatch(output, /wiki\/runbooks\/runbooks-index\.md/);
  assert.doesNotMatch(output, /wiki\/index\.md/);

  const runbooksAfter = await readFile(
    path.join(root, "wiki", "runbooks", "runbooks-index.md"),
    "utf8",
  );
  assert.equal(runbooksAfter, runbooksBefore);
  assert.match(
    await readFile(path.join(root, "wiki", "reports", "reports-index.md"), "utf8"),
    /Reports folder blurb\./,
  );
});

test("downloadSourceAssets writes images without mutating source md", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "source-asset-dl-"));
  await mkdir(path.join(vaultRoot, "wiki", "sources"), { recursive: true });
  const imageUrl = "https://example.com/images/diagram.png";
  const sourceMarkdown = `# Clipped article\n\n![](${imageUrl})\n\nBody text unchanged.\n`;
  const sourcePath = path.join(vaultRoot, "wiki", "sources", "clipped-article.md");
  await writeFile(sourcePath, sourceMarkdown, "utf8");

  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
  };

  const result = await downloadSourceAssets(sourcePath, vaultRoot, { fetchImpl });

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0], imageUrl);
  assert.equal(result.downloaded.length, 1);
  assert.match(result.downloaded[0], /^wiki\/sources\/assets\/clipped-article\/.+\.png$/);

  const assetPath = path.join(vaultRoot, result.downloaded[0]);
  await access(assetPath);
  const assetBytes = await readFile(assetPath);
  assert.equal(assetBytes[0], 0x89);

  const sourceAfter = await readFile(sourcePath, "utf8");
  assert.equal(sourceAfter, sourceMarkdown);
});

test("downloadSourceAssets skips already-downloaded assets", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "source-asset-skip-"));
  await mkdir(path.join(vaultRoot, "wiki", "sources"), { recursive: true });
  const imageUrl = "https://example.com/images/chart.jpg";
  const sourceMarkdown = `# Second clip\n\n![](${imageUrl})\n`;
  const sourcePath = path.join(vaultRoot, "wiki", "sources", "second-clip.md");
  await writeFile(sourcePath, sourceMarkdown, "utf8");

  let fetchCount = 0;
  const fetchImpl = async () => {
    fetchCount += 1;
    return {
      ok: true,
      arrayBuffer: async () => Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    };
  };

  const first = await downloadSourceAssets(sourcePath, vaultRoot, { fetchImpl });
  assert.equal(first.downloaded.length, 1);
  assert.equal(first.skipped.length, 0);
  assert.equal(fetchCount, 1);

  const second = await downloadSourceAssets(sourcePath, vaultRoot, { fetchImpl });
  assert.equal(second.downloaded.length, 0);
  assert.equal(second.skipped.length, 1);
  assert.equal(second.skipped[0], first.downloaded[0]);
  assert.equal(fetchCount, 1);
});

test("markSourceIngested appends source path to wiki/sources/ingested.log", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "ingested-registry-mark-"));
  await mkdir(path.join(vaultRoot, "wiki", "sources"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "sources", "ingested.log"), "", "utf8");

  await markSourceIngested(vaultRoot, "wiki/sources/clipped-article.md");
  const afterFirst = await readFile(path.join(vaultRoot, "wiki", "sources", "ingested.log"), "utf8");
  assert.match(afterFirst, /^wiki\/sources\/clipped-article\.md\n$/);

  await markSourceIngested(vaultRoot, "wiki/sources/raw/drop.md");
  const afterSecond = await readFile(path.join(vaultRoot, "wiki", "sources", "ingested.log"), "utf8");
  assert.equal(
    afterSecond,
    "wiki/sources/clipped-article.md\nwiki/sources/raw/drop.md\n",
    "paths sorted and idempotent append",
  );

  await markSourceIngested(vaultRoot, "wiki/sources/clipped-article.md");
  const afterDuplicate = await readFile(path.join(vaultRoot, "wiki", "sources", "ingested.log"), "utf8");
  assert.equal(afterDuplicate, afterSecond, "duplicate mark is idempotent");
});

test("listPendingSources returns un-ingested markdown under wiki/sources/", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "ingested-registry-pending-"));
  await mkdir(path.join(vaultRoot, "wiki", "sources", "raw"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "sources", "assets", "clipped-article"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "sources", "pending-clip.md"), "# pending\n", "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "sources", "raw", "drop.md"), "# drop\n", "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "sources", "done-clip.md"), "# done\n", "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "sources", "assets", "clipped-article", "diagram.png"), "png", "utf8");
  await writeFile(
    path.join(vaultRoot, "wiki", "sources", "ingested.log"),
    "wiki/sources/done-clip.md\n",
    "utf8",
  );

  const pending = await listPendingSources(vaultRoot);

  assert.deepEqual(pending, ["wiki/sources/pending-clip.md", "wiki/sources/raw/drop.md"]);
});

test("listRawInputDrops returns flat markdown files in raw-input/", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "raw-input-drops-"));
  await mkdir(path.join(vaultRoot, "raw-input"), { recursive: true });
  await mkdir(path.join(vaultRoot, "raw-input", "_failed"), { recursive: true });
  await mkdir(path.join(vaultRoot, "raw-input", "nested"), { recursive: true });
  await writeFile(path.join(vaultRoot, "raw-input", "ubi-2026-05-30-a.md"), "# a\n", "utf8");
  await writeFile(path.join(vaultRoot, "raw-input", "marcos-2026-05-30-b.md"), "# b\n", "utf8");
  await writeFile(path.join(vaultRoot, "raw-input", "note.txt"), "txt", "utf8");
  await writeFile(path.join(vaultRoot, "raw-input", "_failed", "broken.md"), "# broken\n", "utf8");
  await writeFile(path.join(vaultRoot, "raw-input", "nested", "deep.md"), "# deep\n", "utf8");

  const drops = await listRawInputDrops(vaultRoot);

  assert.deepEqual(drops, [
    "raw-input/marcos-2026-05-30-b.md",
    "raw-input/ubi-2026-05-30-a.md",
  ]);
});

test("cheryl-vault-inbox skill is thin wrapper over wiki-curator schema", siblingVaultTestOptions(), () => {
  assert.equal(siblingPathExists(CHERYL_VAULT_INBOX_SKILL_PATH), true);
  assert.equal(siblingPathExists(WIKI_CURATOR_PATH), true);

  const skill = readSiblingText(CHERYL_VAULT_INBOX_SKILL_PATH);
  assert.match(skill, /thin wrapper/i);
  assert.match(skill, /wiki-curator\.md/i);
  assert.match(skill, /wiki curator schema/i);
  assert.match(skill, /wiki-log-preflight/i);
  assert.match(skill, /wiki-log-register/i);
  assert.match(skill, /NO_REPLY/i);

  assert.doesNotMatch(skill, /wiki\/workflows\/raw-input\.md/i);
  assert.doesNotMatch(skill, /Filing buckets/i);
  assert.doesNotMatch(skill, /file them into.*wiki/i);

  const jobs = readRepoText(WIKI_CURATOR_CRON_JOBS_PATH);
  assert.match(jobs, /cheryl-vault-inbox/i);
  assert.match(jobs, /wiki-curator\.md/i);
  assert.match(jobs, /wiki ingest|raw-input\/.*drops/i);
  assert.match(jobs, /wiki-log-register/i);
  assert.match(jobs, /"timeoutSeconds": 600/);
  assert.doesNotMatch(jobs, /wiki\/workflows\/raw-input\.md/i);
  assert.doesNotMatch(jobs, /filing-clerk|Filing buckets/i);
});

test("listMaintenanceBacklog returns unlogged pages in bucket priority order", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "maintenance-backlog-priority-"));
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "workflows"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "reports", "2026-05-01"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "personal"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "workflows", "cron-map.md"), "# cron\n", "utf8");
  await writeFile(
    path.join(vaultRoot, "wiki", "reports", "2026-05-01", "daily.md"),
    "# daily\n",
    "utf8",
  );
  await writeFile(path.join(vaultRoot, "wiki", "personal", "tax.md"), "# tax\n", "utf8");
  await writeFile(
    path.join(vaultRoot, "wiki", "log.md"),
    wikiLogWithRegistryLines([`wiki/personal/tax.md\t2026-05-30T12:00:00Z`]),
    "utf8",
  );

  const backlog = await listMaintenanceBacklog(vaultRoot, { limit: 3 });

  assert.deepEqual(backlog, [
    "wiki/runbooks/playbook.md",
    "wiki/workflows/cron-map.md",
    "wiki/reports/2026-05-01/daily.md",
  ]);
});

test("listMaintenanceBacklog excludes openclaw-docs and index pages", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "maintenance-backlog-exclusions-"));
  await mkdir(path.join(vaultRoot, "wiki", "openclaw-docs", "gateway"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "reports"), { recursive: true });
  await writeFile(
    path.join(vaultRoot, "wiki", "openclaw-docs", "gateway", "doctor.md"),
    "# doctor\n",
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, "wiki", "reports", "reports-index.md"),
    "# reports index\n",
    "utf8",
  );
  await writeFile(path.join(vaultRoot, "wiki", "index.md"), "# master index\n", "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "log.md"), wikiLogWithRegistryLines([]), "utf8");

  const backlog = await listMaintenanceBacklog(vaultRoot);

  assert.deepEqual(backlog, ["wiki/runbooks/playbook.md"]);
});

test("assessIdleConditions reports idle when queues empty and registry complete", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "idle-conditions-idle-"));
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await writeFile(
    path.join(vaultRoot, "wiki", "log.md"),
    wikiLogWithRegistryLines([`wiki/runbooks/playbook.md\t2099-01-01T00:00:00.000Z`]),
    "utf8",
  );

  const status = await assessIdleConditions(vaultRoot);

  assert.equal(status.idle, true);
  assert.equal(status.registryComplete, true);
  assert.equal(status.rawInputEmpty, true);
  assert.equal(status.sourcesIngested, true);
});

test("assessIdleConditions reports not idle when maintenance backlog exists", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "idle-conditions-backlog-"));
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "log.md"), wikiLogWithRegistryLines([]), "utf8");

  const status = await assessIdleConditions(vaultRoot);

  assert.equal(status.idle, false);
  assert.equal(status.registryComplete, false);
});

test("incrementIdleStreak persists streak in agent config and triggers full lint at 4", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "idle-streak-increment-"));
  const configPath = path.join(configDir, "wiki-maintainer-config.json");
  await writeFile(configPath, "{}\n", "utf8");

  const expectedStreaks = [1, 2, 3, 4];
  for (const expected of expectedStreaks) {
    const result = await incrementIdleStreak(configPath);
    assert.equal(result.streak, expected);
    if (expected < 4) {
      assert.equal(result.triggerFullLint, false);
    } else {
      assert.equal(result.triggerFullLint, true);
    }
  }

  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.curatorIdleStreak, 4);
});

test("resetIdleStreak clears curatorIdleStreak to zero", async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), "idle-streak-reset-"));
  const configPath = path.join(configDir, "wiki-maintainer-config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ curatorIdleStreak: 3, otherKey: "preserved" }, null, 2)}\n`,
    "utf8",
  );

  const result = await resetIdleStreak(configPath);

  assert.deepEqual(result, { streak: 0 });
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.curatorIdleStreak, 0);
  assert.equal(persisted.otherKey, "preserved");
});

test("runCuratorCronTick runs locked pipeline phases in order", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "curator-tick-order-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "curator-tick-order-config-"));
  const configPath = path.join(configDir, "wiki-maintainer-config.json");
  await writeFile(configPath, "{}\n", "utf8");
  await ensureWikiLayout(vaultRoot);

  const phases = [];
  const stubDeps = (maintenanceDidWork) => ({
    runPreflight: async () => {
      phases.push("preflight");
    },
    runRawInputIngest: async () => {
      phases.push("rawInput");
      return { didWork: false };
    },
    runRawSourceIngest: async () => {
      phases.push("rawSource");
      return { didWork: false };
    },
    runMaintenance: async () => {
      phases.push("maintenance");
      return maintenanceDidWork
        ? { didWork: true, touched: ["wiki/runbooks/playbook.md"] }
        : { didWork: false };
    },
    runIndexGeneration: async () => {
      phases.push("index");
    },
    runSearchReindex: async () => {
      phases.push("searchReindex");
    },
    runIdleHandling: async () => {
      phases.push("idleHandling");
    },
    runChronicleAppend: async () => {
      phases.push("chronicle");
    },
  });

  await runCuratorCronTick(vaultRoot, configPath, stubDeps(true));

  assert.deepEqual(phases, [
    "preflight",
    "rawInput",
    "rawSource",
    "maintenance",
    "index",
    "searchReindex",
    "idleHandling",
    "chronicle",
  ]);

  phases.length = 0;
  await runCuratorCronTick(vaultRoot, configPath, stubDeps(false));

  assert.deepEqual(phases, [
    "preflight",
    "rawInput",
    "rawSource",
    "maintenance",
    "index",
    "searchReindex",
    "idleHandling",
  ]);
  assert.ok(!phases.includes("chronicle"));
});

test("runCuratorCronTick resets idle streak when any work runs", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "curator-tick-reset-streak-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "curator-tick-reset-streak-config-"));
  const configPath = path.join(configDir, "wiki-maintainer-config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ curatorIdleStreak: 3 }, null, 2)}\n`,
    "utf8",
  );
  await ensureWikiLayout(vaultRoot);
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await writeFile(
    path.join(vaultRoot, "wiki", "log.md"),
    wikiLogWithRegistryLines([`wiki/runbooks/playbook.md\t2099-01-01T00:00:00.000Z`]),
    "utf8",
  );

  let incrementCalled = false;

  await runCuratorCronTick(vaultRoot, configPath, {
    runRawInputIngest: async () => ({
      didWork: true,
      touched: ["wiki/runbooks/playbook.md"],
    }),
    runRawSourceIngest: async () => ({ didWork: false }),
    runMaintenance: async () => ({ didWork: false }),
    runIndexGeneration: async () => {},
    runSearchReindex: async () => {},
    runChronicleAppend: async () => {},
    incrementIdleStreak: async () => {
      incrementCalled = true;
      return { streak: 4, triggerFullLint: true };
    },
  });

  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.curatorIdleStreak, 0);
  assert.equal(incrementCalled, false);
});

test("runCuratorCronTick returns NO_REPLY on idle ticks 1–3", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "curator-tick-idle-noreply-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "curator-tick-idle-noreply-config-"));
  const configPath = path.join(configDir, "wiki-maintainer-config.json");
  await writeFile(configPath, "{}\n", "utf8");
  await ensureWikiLayout(vaultRoot);
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await writeFile(
    path.join(vaultRoot, "wiki", "log.md"),
    wikiLogWithRegistryLines([`wiki/runbooks/playbook.md\t2099-01-01T00:00:00.000Z`]),
    "utf8",
  );

  let lintCallCount = 0;
  const idleSafeDeps = {
    runRawInputIngest: async () => ({ didWork: false }),
    runRawSourceIngest: async () => ({ didWork: false }),
    runMaintenance: async () => ({ didWork: false }),
    runIndexGeneration: async () => {},
    runSearchReindex: async () => {},
    runFullWikiLint: async () => {
      lintCallCount += 1;
    },
  };

  for (let expectedStreak = 1; expectedStreak <= 3; expectedStreak += 1) {
    const result = await runCuratorCronTick(vaultRoot, configPath, idleSafeDeps);
    assert.equal(result.didWork, false);
    assert.equal(result.idle.action, "increment");
    assert.equal(result.idle.reply, "NO_REPLY");
    const persisted = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(persisted.curatorIdleStreak, expectedStreak);
  }

  assert.equal(lintCallCount, 0);
});

test("runCuratorCronTick runs full wiki lint on idle tick 4 then resets streak", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "curator-tick-idle-lint-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "curator-tick-idle-lint-config-"));
  const configPath = path.join(configDir, "wiki-maintainer-config.json");
  await writeFile(
    configPath,
    `${JSON.stringify({ curatorIdleStreak: 3 }, null, 2)}\n`,
    "utf8",
  );
  await ensureWikiLayout(vaultRoot);
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");
  await writeFile(
    path.join(vaultRoot, "wiki", "log.md"),
    wikiLogWithRegistryLines([`wiki/runbooks/playbook.md\t2099-01-01T00:00:00.000Z`]),
    "utf8",
  );

  const lintCalls = [];
  const result = await runCuratorCronTick(vaultRoot, configPath, {
    runRawInputIngest: async () => ({ didWork: false }),
    runRawSourceIngest: async () => ({ didWork: false }),
    runMaintenance: async () => ({ didWork: false }),
    runIndexGeneration: async () => {},
    runSearchReindex: async () => {},
    runFullWikiLint: async (root, options = {}) => {
      lintCalls.push({ root, options });
    },
  });

  assert.equal(lintCalls.length, 1);
  assert.equal(lintCalls[0].root, vaultRoot);
  assert.equal(result.idle.action, "fullLint");
  assert.notEqual(result.idle.reply, "NO_REPLY");
  assert.equal(result.idle.triggerFullLint, true);
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.curatorIdleStreak, 0);
});

test("reindexWikiSearch skips gracefully when qmd absent", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-search-qmd-skip-"));
  await ensureWikiLayout(vaultRoot);
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await writeFile(path.join(vaultRoot, "wiki", "runbooks", "playbook.md"), "# play\n", "utf8");

  const result = await reindexWikiSearch(vaultRoot, {
    paths: ["wiki/runbooks/playbook.md"],
    qmdPath: "/nonexistent/qmd-binary",
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.reason ?? "", /qmd not (installed|available)/i);
});

test("runFullWikiLint detects CLAIM contradiction pair", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-lint-claim-"));
  await ensureWikiLayout(vaultRoot);
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "reports"), { recursive: true });
  const pageA = path.join(vaultRoot, "wiki", "runbooks", "alpha-claim.md");
  const pageB = path.join(vaultRoot, "wiki", "reports", "beta-claim.md");
  await writeFile(pageA, "# Alpha claim\n\nCLAIM: Alpha is true\n", "utf8");
  await writeFile(pageB, "# Beta claim\n\nCLAIM: Alpha is false\n", "utf8");

  const result = await runFullWikiLint(vaultRoot, { limit: 5 });

  assert.equal(result.flagged, 1);
  assert.equal(result.contradictions.length, 1);
  const recordRel = result.contradictions[0].recordRel;
  assert.match(recordRel, /^wiki\/contradictions\/.*\.md$/);
  await access(path.join(vaultRoot, recordRel));
  const recordBody = await readFile(path.join(vaultRoot, recordRel), "utf8");
  assert.match(recordBody, /Alpha is true/);
  assert.match(recordBody, /Alpha is false/);

  const bodyA = await readFile(pageA, "utf8");
  const bodyB = await readFile(pageB, "utf8");
  assert.match(bodyA, /^> \*\*Contradiction:\*\*/m);
  assert.match(bodyB, /^> \*\*Contradiction:\*\*/m);

  const vaultRootMatch = await mkdtemp(path.join(os.tmpdir(), "wiki-lint-claim-match-"));
  await ensureWikiLayout(vaultRootMatch);
  await mkdir(path.join(vaultRootMatch, "wiki", "runbooks"), { recursive: true });
  await mkdir(path.join(vaultRootMatch, "wiki", "reports"), { recursive: true });
  await writeFile(
    path.join(vaultRootMatch, "wiki", "runbooks", "same-a.md"),
    "# Same A\n\nCLAIM: Beta is agreed\n",
    "utf8",
  );
  await writeFile(
    path.join(vaultRootMatch, "wiki", "reports", "same-b.md"),
    "# Same B\n\nCLAIM: Beta is agreed\n",
    "utf8",
  );
  const matchResult = await runFullWikiLint(vaultRootMatch, { limit: 5 });
  assert.equal(matchResult.flagged, 0);
  assert.equal(matchResult.contradictions.length, 0);
});

test("runLightWikiLint flags orphan and missing Related", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "wiki-light-lint-"));
  await ensureWikiLayout(vaultRoot);
  await mkdir(path.join(vaultRoot, "wiki", "runbooks"), { recursive: true });
  await mkdir(path.join(vaultRoot, "wiki", "reports"), { recursive: true });

  const orphanRel = "wiki/runbooks/orphan.md";
  const noRelatedRel = "wiki/reports/no-related.md";
  const linkedRel = "wiki/runbooks/linked.md";
  const hubRel = "wiki/runbooks/hub.md";

  await writeFile(
    path.join(vaultRoot, orphanRel),
    "# Orphan\n\nNo inbound links point here.\n\n## Related\n\n- [[hub]]\n",
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, noRelatedRel),
    "# No related\n\nBody without a Related section.\n",
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, linkedRel),
    "# Linked\n\nWell-formed page.\n\n## Related\n\n- [[hub]]\n",
    "utf8",
  );
  await writeFile(
    path.join(vaultRoot, hubRel),
    "# Hub\n\nLinks to [[linked]] and [[reports/no-related]].\n\n## Related\n\n- [[linked]]\n",
    "utf8",
  );

  const orphanResult = await runLightWikiLint(orphanRel, vaultRoot);
  assert.ok(orphanResult.orphans.includes(orphanRel));
  assert.equal(orphanResult.missingRelated, false);

  const noRelatedResult = await runLightWikiLint(noRelatedRel, vaultRoot);
  assert.equal(noRelatedResult.missingRelated, true);
  assert.equal(noRelatedResult.orphans.includes(noRelatedRel), false);

  const linkedResult = await runLightWikiLint(linkedRel, vaultRoot);
  assert.equal(linkedResult.orphans.includes(linkedRel), false);
  assert.equal(linkedResult.missingRelated, false);
});

const PRODUCER_AGENTS_PATHS = [
  "agent-workspace-vault/ubi/AGENTS.md",
  "agent-workspace-vault/cheryl/AGENTS.md",
  "agent-workspace-vault/marcos/AGENTS.md",
];

test("producer AGENTS.md include interaction capture contract", siblingVaultTestOptions(), () => {
  const publishing = readSiblingText(WIKI_PUBLISHING_PATH);
  assert.match(publishing, /## Interaction capture/i);
  assert.match(publishing, /raw-input\//i);
  assert.match(publishing, /\{agent\}-\{YYYY-MM-DD\}-\{slug\}\.md/);
  assert.match(publishing, /update:\s*wiki\//i);

  for (const agentsPath of PRODUCER_AGENTS_PATHS) {
    assert.equal(siblingPathExists(agentsPath), true, agentsPath);
    const doc = readSiblingText(agentsPath);
    assert.match(doc, /## Interaction capture \(required\)/i, agentsPath);
    assert.match(doc, /raw[- ]input/i, agentsPath);
    assert.match(doc, /raw-input\//i, agentsPath);
    assert.match(doc, /\{YYYY-MM-DD\}-\{slug\}\.md/i, agentsPath);
    assert.match(doc, /update:\s*wiki\//i, agentsPath);
    assert.match(
      doc,
      /(```|`)[^\n]*(ubi|cheryl|marcos)-\d{4}-\d{2}-\d{2}-[^\n`]+|Example:/i,
      agentsPath,
    );
  }
});

test("runCuratorCronTick ingests one pending raw source per tick", async () => {
  const vaultRoot = await mkdtemp(path.join(os.tmpdir(), "curator-tick-raw-source-"));
  const configDir = await mkdtemp(path.join(os.tmpdir(), "curator-tick-raw-source-config-"));
  const configPath = path.join(configDir, "wiki-maintainer-config.json");
  await writeFile(configPath, "{}\n", "utf8");
  await ensureWikiLayout(vaultRoot);

  const imageUrl = "https://example.com/images/alpha-diagram.png";
  const alphaMarkdown = `# Alpha clip\n\n![](${imageUrl})\n\nClipped body stays on disk.\n`;
  const betaMarkdown = "# Beta clip\n\nSecond pending source.\n";
  const alphaPath = path.join(vaultRoot, "wiki", "sources", "alpha-clip.md");
  const betaPath = path.join(vaultRoot, "wiki", "sources", "beta-clip.md");
  await writeFile(alphaPath, alphaMarkdown, "utf8");
  await writeFile(betaPath, betaMarkdown, "utf8");
  await writeFile(path.join(vaultRoot, "wiki", "sources", "ingested.log"), "", "utf8");

  const alphaBefore = await readFile(alphaPath, "utf8");

  const fetchCalls = [];
  const fetchImpl = async (url) => {
    fetchCalls.push(url);
    return {
      ok: true,
      arrayBuffer: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
  };

  const result = await runCuratorCronTick(vaultRoot, configPath, {
    runRawInputIngest: async () => ({ didWork: false }),
    runMaintenance: async () => ({ didWork: false }),
    runIndexGeneration: async () => {},
    runSearchReindex: async () => {},
    runChronicleAppend: async () => {},
    fetchImpl,
  });

  assert.equal(result.didWork, true);
  assert.ok(result.touched.some((p) => p.startsWith("wiki/")));

  const ingestedLog = await readFile(path.join(vaultRoot, "wiki", "sources", "ingested.log"), "utf8");
  assert.equal(ingestedLog, "wiki/sources/alpha-clip.md\n");
  assert.deepEqual(await listPendingSources(vaultRoot), ["wiki/sources/beta-clip.md"]);

  assert.equal(await readFile(alphaPath, "utf8"), alphaBefore);

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0], imageUrl);
  const assetDir = path.join(vaultRoot, "wiki", "sources", "assets", "alpha-clip");
  const assetEntries = await readdir(assetDir);
  assert.equal(assetEntries.length, 1);
  assert.match(assetEntries[0], /\.png$/);

  const summaryPath = path.join(vaultRoot, "wiki", "reports", "alpha-clip.md");
  await access(summaryPath);
  const summaryBody = await readFile(summaryPath, "utf8");
  assert.match(summaryBody, /# Alpha clip/);
  assert.match(summaryBody, /Clipped body stays on disk/);
});
