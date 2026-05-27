# Documentation inventory (issue #26)

Classification pass for the four in-scope repos on branch `refactor/docs-prd-26-cross-repo`. Buckets follow issue #26 Implementation Decisions.

**Legend**

| Bucket | Meaning |
|--------|---------|
| **active canonical** | Current operational truth; exactly one home per fact |
| **active derived** | Thin pointers, skills, or setup notes that link to canonical docs without restating architecture |
| **historical** | Preserved context; explicitly not source of truth |
| **workspace-only** | Agent workspace process/persona; not pipeline runtime truth |
| **delete candidates** | Removed or slated for removal; listed for audit trail |

---

## UbiClawBot

| Path | Bucket | Notes |
|------|--------|-------|
| `docs/README.md` | active canonical | Docs landing; links topic areas |
| `docs/deployment/README.md` | active canonical | Deploy model, artifact tree, compose services |
| `docs/deployment/secrets.md` | active canonical | Actions + droplet secret contract |
| `docs/deployment/live-verification.md` | active canonical | Droplet spot-check record (done/waived/blocked) |
| `docs/services/trello-gateway.md` | active canonical | Gateway service contract |
| `docs/services/trello-pipeline.md` | active canonical | Webhook ingress, queue worker, handlers |
| `docs/services/trello-routines.md` | active canonical | Scheduled routines job |
| `docs/integrations/github-pr-webhook.md` | active canonical | PR review intake |
| `docs/architecture/README.md` | active canonical | Pipeline vs workspace boundary |
| `docs/adr/0001-trello-pipeline-ownership.md` | historical | ADR with historical banner; points to `docs/` |
| `README.md` | active derived | Root entry; links `docs/README.md`, glossary |
| `AGENTS.md` | active derived | Thin agent guidance; links canonical docs |
| `CONTEXT.md` | workspace-only | Glossary artifact (stays at root per PRD) |
| `DEPLOY.md` | delete candidates | Removed — absorbed into `docs/deployment/` |
| `SECRETS-OPERATIONS.md` | delete candidates | Removed — absorbed into `docs/deployment/secrets.md` |
| `GITHUB-PR-WEBHOOK.md` | delete candidates | Removed — absorbed into `docs/integrations/github-pr-webhook.md` |
| `trello-gateway/README.md` | delete candidates | Removed — service truth in `docs/services/trello-gateway.md` |
| `trello-pipeline/README.md` | delete candidates | Removed — service truth in `docs/services/trello-pipeline.md` |
| `trello-routines/README.md` | delete candidates | Removed — service truth in `docs/services/trello-routines.md` |

**Deploy-contract artifacts (not markdown, gate-validated):** `.github/workflows/deploy-droplet.yml`, `workspace/docker-compose.droplet.yml`, `Caddyfile.droplet`, `config/openclaw.example.json`.

---

## UbiAgent

| Path | Bucket | Notes |
|------|--------|-------|
| `AGENTS.md` | active derived | Points to `UbiClawBot/docs/` |
| `skills/trello-gateway/SKILL.md` | active derived | Gateway ops; links canonical gateway doc |
| `scripts/trello/gateway/SETUP.md` | active derived | Local setup; links `docs/services/trello-gateway.md` |
| `marcos-prompts/copy-gateway-to-container.md` | active derived | Prompt aligned with canonical gateway doc |
| `trello_bridge/README.md` | active derived | Redirect stub; pipeline moved to UbiClawBot |
| `Docs/Internal Docs/trello_production_architecture.md` | delete candidates | **Removed** — pointer-only stub; use `UbiClawBot/docs/` |
| `Docs/Internal Docs/trello_calendar_workflow.md` | delete candidates | **Removed** — pointer-only stub; use `UbiClawBot/docs/` |
| `Docs/Reports/**` | historical | RCAs, audits, job search — out of scope for active truth |
| `skills/ubi-trello-ops/SKILL.md` | workspace-only | Agent Trello ops skill (not pipeline deploy truth) |
| `skills/ubi-calendar-scheduling/SKILL.md` | workspace-only | Cheryl/Ubi scheduling process |
| `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, `HEARTBEAT.md`, `DREAMS.md` | workspace-only | Persona/state |
| `memory/**` | workspace-only | Session memory; not documentation system |

---

## MarcosAgent

| Path | Bucket | Notes |
|------|--------|-------|
| `AGENTS.md` | active derived | Points to `UbiClawBot/docs/` |
| `skills/trello-gateway/SKILL.md` | active derived | Links canonical gateway doc |
| `trello-refactor/README.md` | delete candidates | **Removed** — pointer index only |
| `trello-refactor/trello_production_architecture.md` | delete candidates | **Removed** — pointer stub |
| `trello-refactor/trello_bridge_event_map.md` | delete candidates | **Removed** — pointer stub |
| `trello-refactor/trello_implementation_plan.md` | delete candidates | **Removed** — pointer stub |
| `trello-refactor/trello_gateway_proposal.md` | delete candidates | **Removed** — pointer stub |
| `trello-refactor/trello_architecture_audit.md` | delete candidates | **Removed** — pointer stub |
| `trello-refactor/doc_conflicts_*.md` | historical | Conflict notes from migration |
| `trello-refactor/*.md` (RCAs, matrices, proposals) | historical | Preserved under `trello-refactor/` |
| `skills/marcos-*`, `skills/draft-ubi-trello-ops/**` | workspace-only | Agent skills and drafts |
| `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, etc. | workspace-only | Persona/state |

---

## CherylAgent

| Path | Bucket | Notes |
|------|--------|-------|
| `AGENTS.md` | active derived | Points to `UbiClawBot/docs/` |
| `skills/trello-gateway/SKILL.md` | active derived | Links canonical gateway doc |
| `skills/cheryl-trello-calendar-sync/SKILL.md` | workspace-only | Calendar sync process (not deploy contract) |
| `skills/cheryl-*` (other) | workspace-only | Agent-specific scheduling/ops |
| `IDENTITY.md`, `SOUL.md`, `USER.md`, `MEMORY.md`, etc. | workspace-only | Persona/state |

---

## Cross-repo rules (issue #26)

- **One canonical home:** active pipeline/deploy/integration/service truth lives only under `UbiClawBot/docs/`.
- **No pointer duplicates:** forbidden paths in `scripts/test-gate.mjs` must stay absent (no demoted stubs that only link to `UbiClawBot/docs/`).
- **Workspace boundary:** agent repos keep process/skills/memory; they must not claim production runtime ownership.
- **Gate enforcement:** `scripts/test-gate.mjs` checks structure, forbidden duplicates, and cross-repo pointers.

**Last updated:** 2026-05-26 (Ralph loop prd-26-github-v2, cycle 1 implement).
