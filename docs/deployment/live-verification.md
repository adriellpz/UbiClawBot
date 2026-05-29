# Live deployment verification

Record for issue #26 Testing Decisions: deployment and integration claims validated against live environment where possible.

## Status

| Field | Value |
|-------|-------|
| **status** | `done` |
| **date** | 2026-05-29 |
| **reviewer** | Ralph loop implement (cycle 3) |

Wiki raw-input Phase 1+2 executed on droplet via `ssh myserver` as **root** (chown `deploy:deploy` after vault mutations). Tools rsynced to `/home/deploy/openclaw/tools/agent-workspace-vault/`. Active-surface legacy path scan reports **0** remaining `Docs/` hits on agent skills/cron after rewrite; smoke-verifier **PASS**.

## Deployment model (artifact tree vs git checkout)

Per issue Further Notes and [`README.md`](./README.md):

| Model | Path | Role |
|-------|------|------|
| **Artifact tree (live)** | `/home/deploy/openclaw` on the droplet | Deployed runtime: files copied by GitHub Actions (`deploy-droplet.yml`), not a `git pull` workspace |
| **Git checkout (source)** | `UbiClawBot` repo on `main` | Source of truth for *what to deploy*; CI copies tracked paths via SCP then SSH restart script |

Operators must **not** treat `/home/deploy/openclaw` as a pullable clone or run `git pull` there. Updates flow: push to `main` (or manual `workflow_dispatch`) → workflow copies artifacts → `docker compose` rebuild/restart on droplet.

Persistent droplet-only paths (not overwritten by deploy): `/home/deploy/openclaw/.env`, `/home/deploy/openclaw/trello-gateway/.env`, `/home/deploy/openclaw/data/*` (see [`secrets.md`](./secrets.md)).

## What was verified locally

| Check | Result |
|-------|--------|
| `npm test` in UbiClawBot | PASS — 98/98 (2026-05-29 implement cycle 3) |
| `docs/deployment/README.md` | States artifact tree at `/home/deploy/openclaw`; no `git pull` guidance |
| `.github/workflows/deploy-droplet.yml` | SCP + SSH deploy; copies tracked bundles; restarts compose services |
| Cross-repo docs gate | Historical architecture paths demoted; agent pointers to `UbiClawBot/docs/` |

## Wiki bootstrap spot-check (REQ-P0-012) — 2026-05-29

| Check | Result |
|-------|--------|
| `raw-input/` + `raw-input/_failed/` | **Present** under `/home/deploy/openclaw/data/agent-vault/` |
| `wiki/` six buckets | **Present** — `reports/`, `runbooks/`, `job-search/`, `personal/`, `projects/`, `workflows/` (+ `openclaw-docs/`) |
| `bootstrap-wiki.mjs` on droplet | **Present** — rsync from `agent-workspace-vault`; dry-run + live executed |
| Active-surface `Docs/` (`rewrite-vault-paths.mjs --smoke-only`) | **0 remaining** (108 files scanned) before final smoke; rewrite pass updated 48 historical wiki files (343 replacements) |
| `smoke-verifier.mjs --vault-root …` | **PASS** — layout, workspaces, legacy-paths, gateway healthz |
| Phase 2 `wiki/workflows/raw-input.md` | **Present** |
| Phase 2 `cheryl/skills/cheryl-vault-inbox/` | **Present** (`SKILL.md`) |
| Cheryl `*/15` raw-input cron in `jobs.json` | **Present** — `agentId: scheduler`, `*/15 * * * *`, `America/Denver`, NO_REPLY if empty; model `opencode-go/deepseek-v4-flash` per [`openclaw-agents.md`](./openclaw-agents.md) |
| Curator smoke drop | **Filed manually** during vault cleanup to `wiki/workflows/ubi-2026-05-30-handoff-test.md`; async cron filing not separately awaited |

### Droplet command evidence (redacted)

```
# rsync tools (local → droplet)
rsync -av --delete …/agent-workspace-vault/ root@myserver:/home/deploy/openclaw/tools/agent-workspace-vault/

# Phase 1
node …/bootstrap-wiki.mjs --vault /home/deploy/openclaw/data/agent-vault \
  --docs /root/openclaw/data/workspace.old/Docs --marcos …/marcos --dry-run  # errors: []
node …/bootstrap-wiki.mjs … # live, errors: []
node …/rewrite-vault-paths.mjs --root …/agent-vault  # changedFiles: 48, totalReplacements: 343, smoke.remaining: 0
node …/generate-vault-indexes.mjs --root …/agent-vault
chown -R deploy:deploy /home/deploy/openclaw/data/agent-vault
node …/smoke-verifier.mjs --vault-root …/agent-vault  # Smoke: OK

# Legacy path scan (active surface)
node …/rewrite-vault-paths.mjs --smoke-only --root …/agent-vault
# → { "scanned": 108, "remaining": 0, "matches": [] }

# Compose health (2026-05-29)
docker compose ps  # openclaw-gateway, trello-*, github-pr-bridge: Up (healthy)
```

### AGENTS.md / Marcos runbooks

- `ubi/`, `cheryl/`, `marcos/` AGENTS.md include wiki read + `raw-input/` producer rules; Cheryl documents `cheryl-vault-inbox` curator.
- Marcos pointers: `wiki/runbooks/marcos/master.md`, `nightly-prompt.md`, `scope-rules.md` on droplet.

## Waived

Use **status: `waived`** only with an explicit owner reason. Not applicable after cycle 3 droplet execution.

---

**Related:** [`README.md`](./README.md) (deploy model), [`../inventory.md`](../inventory.md) (doc classification).
