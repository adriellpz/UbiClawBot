import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_ROOT_MARKDOWN,
  listRootMarkdownFiles,
  readRepoText,
  repoPathExists,
  INVENTORY_BUCKETS,
  INVENTORY_REPOS,
  DEPLOYMENT_README_REQUIRED,
  RUNTIME_CONTRACT_DOCS,
  REQUIRED_CANONICAL_DOC_PATHS,
  STALE_DOC_PATHS,
  ARCHITECTURE_BOUNDARY_REPOS,
  ADR_0001_HISTORICAL_BANNER,
  ADR_0002_PATH,
  ADR_0002_ACCEPTED_STATUS,
  ADR_0003_PATH,
  ADR_0004_PATH,
  FORBIDDEN_POINTER_DOC_PATHS,
  readSiblingText,
  siblingPathExists,
  SIBLING_AGENT_AGENTS_PATHS,
  SIBLING_AGENTS_CANONICAL_DOCS_POINTER,
  GATEWAY_SETUP_DOC_PATH,
  GATEWAY_PROMPT_DOC_PATH,
  GATEWAY_SKILL_PATHS,
  GATEWAY_DOC_SETUP_REQUIRED,
  GATEWAY_DOC_SKILL_REQUIRED,
  GATEWAY_DOC_FORBIDDEN,
  ROOT_ENTRY_DOC_PATHS,
  ROOT_ENTRY_DOC_POINTER,
  ROOT_ENTRY_DOC_FORBIDDEN,
  repoRoot,
} from "./docs-contract.helpers.mjs";
import { readFileSync } from "node:fs";
import path from "node:path";

test("UbiClawBot repo root allows only AGENTS.md, CONTEXT.md, and README.md", () => {
  const rootMarkdown = listRootMarkdownFiles();
  assert.deepEqual(rootMarkdown, ALLOWED_ROOT_MARKDOWN);
});

test("stale root manuals and service READMEs are absent", () => {
  for (const relativePath of STALE_DOC_PATHS) {
    assert.equal(repoPathExists(relativePath), false, `${relativePath}: stale duplicate doc should be removed`);
  }
});

test("required canonical docs pages exist", () => {
  for (const relativePath of REQUIRED_CANONICAL_DOC_PATHS) {
    assert.equal(repoPathExists(relativePath), true, `${relativePath}: expected canonical docs page`);
  }
});

test("docs landing page links deployment inventory and live-verification", () => {
  const docsIndex = readRepoText("docs/README.md");
  assert(docsIndex.includes("canonical home"), "docs/README.md: should describe canonical ownership");
  assert(docsIndex.includes("deployment/README.md"), "docs/README.md: should link deployment docs");
  assert(docsIndex.includes("inventory.md"), "docs/README.md: should link documentation inventory");
  assert(docsIndex.includes("live-verification.md"), "docs/README.md: should link live verification record");

  for (const docPath of ROOT_ENTRY_DOC_PATHS) {
    const doc = readRepoText(docPath);
    assert(doc.includes(ROOT_ENTRY_DOC_POINTER), `${docPath}: should point to docs/README.md`);
    assert(!doc.includes(ROOT_ENTRY_DOC_FORBIDDEN), `${docPath}: should not point back to DEPLOY.md`);
  }
});

test("docs inventory lists five buckets for four repos", () => {
  const inventoryDoc = readRepoText("docs/inventory.md");
  for (const bucket of INVENTORY_BUCKETS) {
    assert(inventoryDoc.includes(bucket), `docs/inventory.md: expected bucket ${bucket}`);
  }
  for (const repo of INVENTORY_REPOS) {
    assert(inventoryDoc.includes(repo), `docs/inventory.md: expected inventory for ${repo}`);
  }
});

test("live-verification record declares status and artifact-tree model", () => {
  const liveVerification = readRepoText("docs/deployment/live-verification.md");
  assert(
    /\bstatus\b[\s\S]*\b(?:done|waived|blocked)\b/iu.test(liveVerification),
    "docs/deployment/live-verification.md: should declare status done, waived, or blocked",
  );
  assert(liveVerification.includes("artifact tree"), "docs/deployment/live-verification.md: should document artifact-tree model");
  assert(
    liveVerification.includes("git checkout") || liveVerification.includes("git pull"),
    "docs/deployment/live-verification.md: should contrast with git-checkout/pull assumptions",
  );
});

test("deployment README documents artifact tree and forbids git pull on droplet", () => {
  const deployDoc = readRepoText("docs/deployment/README.md");
  for (const expected of DEPLOYMENT_README_REQUIRED) {
    assert(deployDoc.includes(expected), `docs/deployment/README.md: expected ${expected}`);
  }
  assert(
    !deployDoc.includes("git pull"),
    "docs/deployment/README.md: should not tell operators to git pull the droplet artifact tree",
  );
});

test("service and integration docs include required runtime contracts", () => {
  for (const { path: docPath, required } of RUNTIME_CONTRACT_DOCS) {
    const doc = readRepoText(docPath);
    for (const expected of required) {
      assert(doc.includes(expected), `${docPath}: expected ${expected}`);
    }
  }
});

test("architecture README states pipeline vs agent workspace boundary", () => {
  const architectureDoc = readRepoText("docs/architecture/README.md");
  for (const repo of ARCHITECTURE_BOUNDARY_REPOS) {
    assert(architectureDoc.includes(repo), `docs/architecture/README.md: expected ${repo} in pipeline vs workspace boundary`);
  }
});

test("ADR-0001 carries historical note banner", () => {
  const adr = readRepoText("docs/adr/0001-trello-pipeline-ownership.md");
  assert(
    adr.includes(ADR_0001_HISTORICAL_BANNER),
    "docs/adr/0001-trello-pipeline-ownership.md: should carry a historical note",
  );
});

test("forbidden pointer-only duplicate docs absent in sibling repos", () => {
  for (const docPath of FORBIDDEN_POINTER_DOC_PATHS) {
    assert.equal(
      siblingPathExists(docPath),
      false,
      `${docPath}: pointer-only duplicate doc should be removed (use UbiClawBot/docs/)`,
    );
  }
});

test("sibling agent AGENTS.md files point to UbiClawBot/docs", () => {
  for (const agentsPath of SIBLING_AGENT_AGENTS_PATHS) {
    const agents = readSiblingText(agentsPath);
    if (!agents) continue;
    assert(
      agents.includes(SIBLING_AGENTS_CANONICAL_DOCS_POINTER),
      `${agentsPath}: should point workspace readers to UbiClawBot/docs/`,
    );
  }
});

test("gateway skills and setup docs align with canonical gateway doc", () => {
  for (const docPath of [GATEWAY_SETUP_DOC_PATH, GATEWAY_PROMPT_DOC_PATH]) {
    const doc = readSiblingText(docPath);
    if (!doc) continue;
    for (const expected of GATEWAY_DOC_SETUP_REQUIRED) {
      assert(doc.includes(expected), `${docPath}: expected ${expected}`);
    }
    for (const forbidden of GATEWAY_DOC_FORBIDDEN) {
      assert(!doc.includes(forbidden), `${docPath}: should not include ${forbidden}`);
    }
  }

  for (const skillPath of GATEWAY_SKILL_PATHS) {
    const skill = readSiblingText(skillPath);
    if (!skill) continue;
    for (const expected of GATEWAY_DOC_SKILL_REQUIRED) {
      assert(skill.includes(expected), `${skillPath}: expected ${expected}`);
    }
    for (const forbidden of GATEWAY_DOC_FORBIDDEN) {
      assert(!skill.includes(forbidden), `${skillPath}: should not include ${forbidden}`);
    }
  }
});

test("npm test runs docs-contract via node:test without test-gate monolith", () => {
  const packageJson = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const testScript = packageJson.scripts?.test ?? "";
  assert(
    testScript.includes("docs-contract.test.mjs"),
    "package.json scripts.test: should invoke docs-contract.test.mjs via node:test",
  );
  assert(
    !testScript.includes("scripts/test-gate.mjs") && !testScript.includes("test-gate.mjs"),
    "package.json scripts.test: should not invoke the test-gate monolith",
  );
  assert(testScript.includes("node --test"), "package.json scripts.test: should use node:test runner");
});

test("ADR-0002 accepted documents node:test migration", () => {
  assert.equal(repoPathExists(ADR_0002_PATH), true, `${ADR_0002_PATH}: ADR-0002 should exist`);
  const adr = readRepoText(ADR_0002_PATH);
  assert(adr.includes(ADR_0002_ACCEPTED_STATUS), `${ADR_0002_PATH}: frontmatter status should be accepted`);
  assert(adr.includes("node:test"), `${ADR_0002_PATH}: should document node:test migration`);
  assert(
    adr.includes("two tests per implement phase"),
    `${ADR_0002_PATH}: should document two-tests-per-phase Ralph TDD`,
  );
});

test("ADR 0004 LLM wiki maintainer doc exists", () => {
  assert.equal(repoPathExists(ADR_0004_PATH), true);
});

test("ADR 0004 references ADR 0003 and maintainer shift", () => {
  const adr = readRepoText(ADR_0004_PATH);
  assert.match(adr, /0003-raw-input-wiki-curator/i);
  assert.match(adr, /wiki maintainer/i);
  assert.match(adr, /sources\//);
  assert.match(adr, /wiki log/i);
});

test("CONTEXT.md maintainer glossary batch 1", () => {
  const ctx = readRepoText("CONTEXT.md");
  assert.match(ctx, /\*\*raw sources\*\*/i);
  assert.match(ctx, /\*\*wiki log\*\*/i);
  assert.match(ctx, /\*\*page format contract\*\*/i);
  assert.match(ctx, /\*\*wiki publishing schema\*\*/i);
  assert.match(ctx, /\*\*wiki curator schema\*\*/i);
});

test("CONTEXT.md maintainer glossary batch 2", () => {
  const ctx = readRepoText("CONTEXT.md");
  assert.match(ctx, /\*\*wiki maintainer\*\*|\*\*wiki curator\*\*/i);
  assert.match(ctx, /sources\/ingested\.log/i);
});
