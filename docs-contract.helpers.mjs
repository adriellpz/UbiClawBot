import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.dirname(fileURLToPath(import.meta.url));

export function listRootMarkdownFiles() {
  return readdirSync(repoRoot)
    .filter((entry) => entry.endsWith(".md"))
    .sort();
}

export function repoPathExists(relativePath) {
  return existsSync(path.join(repoRoot, relativePath));
}

export const ALLOWED_ROOT_MARKDOWN = ["AGENTS.md", "CONTEXT.md", "README.md"];

export const REQUIRED_CANONICAL_DOC_PATHS = [
  "docs/README.md",
  "docs/inventory.md",
  "docs/deployment/README.md",
  "docs/deployment/live-verification.md",
  "docs/deployment/secrets.md",
  "docs/deployment/openclaw-agents.md",
  "docs/deployment/droplet-backup.md",
  "docs/services/trello-gateway.md",
  "docs/services/trello-pipeline.md",
  "docs/services/trello-routines.md",
  "docs/integrations/github-pr-webhook.md",
  "docs/architecture/README.md",
  "docs/adr/0001-trello-pipeline-ownership.md",
  "docs/adr/0003-raw-input-wiki-curator.md",
];

export const ADR_0003_PATH = "docs/adr/0003-raw-input-wiki-curator.md";

export function readRepoText(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

export const INVENTORY_BUCKETS = [
  "active canonical",
  "active derived",
  "historical",
  "workspace-only",
  "delete candidates",
];

export const INVENTORY_REPOS = ["UbiClawBot", "UbiAgent", "MarcosAgent", "CherylAgent"];

export const DEPLOYMENT_README_REQUIRED = [
  "schedule",
  "workflow_dispatch",
  "/home/deploy/openclaw",
  "artifact tree",
  "DROPLET_HOST",
  "DROPLET_USER",
  "DROPLET_SSH_KEY",
];

/** Gate-expected strings per service/integration doc (REQ-P0-001 runtime contracts). */
export const RUNTIME_CONTRACT_DOCS = [
  {
    path: "docs/deployment/secrets.md",
    required: ["/home/deploy/openclaw/.env", "/home/deploy/openclaw/trello-gateway/.env", "GITHUB_PR_WEBHOOK_SECRET"],
  },
  {
    path: "docs/services/trello-gateway.md",
    required: ["TRELLO_GATEWAY_URL", "TRELLO_GATEWAY_KEY", "/home/deploy/openclaw/trello-gateway", "http://trello-gateway:18792"],
  },
  {
    path: "docs/services/trello-pipeline.md",
    required: ["/opt/trello-pipeline", "TRELLO_PIPELINE_STATE_DIR", "TRELLO_GATEWAY_URL"],
  },
  {
    path: "docs/services/trello-routines.md",
    required: ["/opt/trello-routines", "TRELLO_ROUTINES_STATE_DIR", "TRELLO_GATEWAY_URL"],
  },
  {
    path: "docs/integrations/github-pr-webhook.md",
    required: ["https://ai.sonofwolf.org/github-pr", "pull_request", "GITHUB_PR_WEBHOOK_SECRET"],
  },
];

export const STALE_DOC_PATHS = [
  "DEPLOY.md",
  "SECRETS-OPERATIONS.md",
  "GITHUB-PR-WEBHOOK.md",
  "trello-gateway/README.md",
  "trello-pipeline/README.md",
  "trello-routines/README.md",
];

/** Repos named in docs/architecture/README.md for pipeline vs workspace boundary (REQ-P0-004). */
export const ARCHITECTURE_BOUNDARY_REPOS = ["UbiClawBot", "UbiAgent"];

/** Banner prefix in docs/adr/0001-trello-pipeline-ownership.md (REQ-P0-006). */
export const ADR_0001_HISTORICAL_BANNER = "Historical note";

/** ADR-0002 path and acceptance contract (ADR-0002). */
export const ADR_0002_PATH = "docs/adr/0002-documentation-contract-via-node-test.md";

export const ADR_0002_ACCEPTED_STATUS = "status: accepted";

export const workspaceRoot = path.resolve(repoRoot, "..");

export function siblingPathExists(relativePath) {
  return existsSync(path.join(workspaceRoot, relativePath));
}

export function readSiblingText(relativePath) {
  const absolute = path.join(workspaceRoot, relativePath);
  if (!existsSync(absolute)) return null;
  return readFileSync(absolute, "utf8");
}

/** Pointer-only duplicates must be deleted, not demoted (issue #26 — CL-04). */
export const FORBIDDEN_POINTER_DOC_PATHS = [
  "UbiAgent/Docs/Internal Docs/trello_production_architecture.md",
  "UbiAgent/Docs/Internal Docs/trello_calendar_workflow.md",
  "MarcosAgent/trello-refactor/README.md",
  "MarcosAgent/trello-refactor/trello_production_architecture.md",
  "MarcosAgent/trello-refactor/trello_bridge_event_map.md",
  "MarcosAgent/trello-refactor/trello_implementation_plan.md",
  "MarcosAgent/trello-refactor/trello_gateway_proposal.md",
  "MarcosAgent/trello-refactor/trello_architecture_audit.md",
];

export const SIBLING_AGENT_AGENTS_PATHS = [
  "UbiAgent/AGENTS.md",
  "MarcosAgent/AGENTS.md",
  "CherylAgent/AGENTS.md",
];

export const SIBLING_AGENTS_CANONICAL_DOCS_POINTER = "UbiClawBot/docs/";

export const CANONICAL_GATEWAY_DOC = "UbiClawBot/docs/services/trello-gateway.md";

export const GATEWAY_SETUP_DOC_PATH = "UbiAgent/scripts/trello/gateway/SETUP.md";

export const GATEWAY_PROMPT_DOC_PATH = "UbiAgent/marcos-prompts/copy-gateway-to-container.md";

export const GATEWAY_SKILL_PATHS = [
  "UbiAgent/skills/trello-gateway/SKILL.md",
  "MarcosAgent/skills/trello-gateway/SKILL.md",
  "CherylAgent/skills/trello-gateway/SKILL.md",
];

/** Shared gateway-doc contract strings (REQ-P0-010). */
export const GATEWAY_DOC_SETUP_REQUIRED = [
  CANONICAL_GATEWAY_DOC,
  "unless-stopped",
  "does not launch or monitor the gateway via `start_gateway.mjs`",
];

export const GATEWAY_DOC_SKILL_REQUIRED = [
  CANONICAL_GATEWAY_DOC,
  "unless-stopped",
  "GET /healthz",
  "does not launch or monitor the gateway via `start_gateway.mjs`",
];

export const GATEWAY_DOC_FORBIDDEN = ["git pull", "restart: always"];

/** Root entry docs must point at docs/README.md, not retired DEPLOY.md (REQ-P0-002). */
export const ROOT_ENTRY_DOC_PATHS = ["README.md", "AGENTS.md"];

export const ROOT_ENTRY_DOC_POINTER = "docs/README.md";

export const ROOT_ENTRY_DOC_FORBIDDEN = "DEPLOY.md";
