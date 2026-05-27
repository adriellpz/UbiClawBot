# Live deployment verification

Record for issue #26 Testing Decisions: deployment and integration claims validated against live environment where possible.

## Status

| Field | Value |
|-------|-------|
| **status** | `blocked` |
| **date** | 2026-05-26 |
| **reviewer** | Ralph loop implement (cycle 1) |

Droplet SSH spot-check was **not performed** in this session: no `DROPLET_HOST` / `DROPLET_SSH_KEY` available to the agent environment (`ssh` to droplet: connection refused / host unset).

## Deployment model (artifact tree vs git checkout)

Per issue Further Notes and [`README.md`](./README.md):

| Model | Path | Role |
|-------|------|------|
| **Artifact tree (live)** | `/home/deploy/openclaw` on the droplet | Deployed runtime: files copied by GitHub Actions (`deploy-droplet.yml`), not a `git pull` workspace |
| **Git checkout (source)** | `UbiClawBot` repo on `main` | Source of truth for *what to deploy*; CI copies tracked paths via SCP then SSH restart script |

Operators must **not** treat `/home/deploy/openclaw` as a pullable clone or run `git pull` there. Updates flow: push to `main` (or manual `workflow_dispatch`) → workflow copies artifacts → `docker compose` rebuild/restart on droplet.

Persistent droplet-only paths (not overwritten by deploy): `/home/deploy/openclaw/.env`, `/home/deploy/openclaw/trello-gateway/.env`, `/home/deploy/openclaw/data/*` (see [`secrets.md`](./secrets.md)).

## What was verified locally (blocked session)

Without SSH, the following repo-local checks support the documented model:

| Check | Result |
|-------|--------|
| `npm test` in UbiClawBot | PASS — unit tests + `scripts/test-gate.mjs` |
| `docs/deployment/README.md` | States artifact tree at `/home/deploy/openclaw`; no `git pull` guidance |
| `.github/workflows/deploy-droplet.yml` | SCP + SSH deploy; copies `workspace/`, `trello-*`, `github-pr-bridge`, `Caddyfile.droplet`; restarts compose services |
| `workspace/docker-compose.droplet.yml` | Services: `openclaw-gateway`, `trello-bridge`, `github-pr-bridge`, `trello-gateway`, `trello-queue-worker`, `trello-routines` |
| Embedded SSH script | `bash -n` passes per test-gate |
| Cross-repo docs gate | Historical architecture paths demoted; agent pointers to `UbiClawBot/docs/` |

## What remains for `status: done`

When an operator has droplet SSH (GitHub Actions secrets `DROPLET_HOST`, `DROPLET_USER`, `DROPLET_SSH_KEY`):

1. `ssh` to droplet; `cd /home/deploy/openclaw && docker compose ps` — confirm expected services healthy.
2. Confirm path is artifact tree (no `.git` as primary update mechanism, or document if present but unused).
3. Spot-check `curl` / health endpoints per `docs/services/*.md` (e.g. gateway `GET /healthz` on host bind `127.0.0.1:18792`).
4. Update this file: set **status** to `done`, add date and command output snippets (redact secrets).

## Waived

Use **status: `waived`** only with an explicit owner reason (e.g. staging-only environment, temporary droplet outage with accepted risk). Not applicable in cycle 1.

---

**Related:** [`README.md`](./README.md) (deploy model), [`../inventory.md`](../inventory.md) (doc classification).
