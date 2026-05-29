# Deployment

## Current deploy model

Deploys are driven by `.github/workflows/deploy-droplet.yml`:

- push to `main`
- nightly `schedule`
- manual `workflow_dispatch`

The workflow copies the artifact set declared in [`deploy/manifest.json`](../../deploy/manifest.json) into `/home/deploy/openclaw`, validates Caddy, rebuilds `openclaw-gateway` and `trello-gateway`, runs post-deploy smoke checks, writes `deployed-revision.json`, then force-recreates:

- `openclaw-gateway`
- `openclaw-cli`
- `trello-bridge`
- `github-pr-bridge`
- `trello-gateway`
- `trello-queue-worker`
- `trello-routines`

`/home/deploy/openclaw` is the deployed artifact tree, not a pullable git checkout. Do not treat that path as the repo clone and do not rely on pull-based updates there.

After a successful deploy, check what landed:

```bash
cat /home/deploy/openclaw/deployed-revision.json
cat /home/deploy/openclaw/deploy/manifest.json
```

Manual ops scripts (for example routine due backfill) live at `/home/deploy/openclaw/scripts/manual/` and are copied on every deploy — do not SCP them by hand.

CI enforces that `.github/workflows/deploy-droplet.yml` stays in sync with `deploy/manifest.json` via `deploy-contract.test.mjs`.

## What stays on the droplet

The workflow updates tracked files only. It does not overwrite:

- `/home/deploy/openclaw/.env`
- `/home/deploy/openclaw/trello-gateway/.env`
- `/home/deploy/openclaw/data/*`

See [`secrets.md`](./secrets.md) for the secret contract.

### Agent workspace vault (compose)

After vault migration on the droplet, set in `/home/deploy/openclaw/.env` (not overwritten by deploy):

- `OPENCLAW_AGENT_VAULT_DIR` — host path to the Obsidian-synced vault (`data/agent-vault` on the droplet)
- `OPENCLAW_AGENT_RUNTIME_DIR` — host path to non-synced runtime scripts (`data/agent-runtime`)

Point each agent’s `workspace` in live `openclaw.json` at `/home/node/.openclaw/agent-vault/{ubi,cheryl,marcos}`. Legacy `workspace` trees on the host are renamed to `*.old` for rollback; compose no longer mounts `/home/node/.openclaw/workspace`.

Live droplet spot-check record: [`live-verification.md`](./live-verification.md).

## Failure model

A deploy is only healthy when the restarted services pass their health checks. If the workflow fails after file copy or image build, inspect the live compose state on the droplet first:

```bash
cd /home/deploy/openclaw
docker compose ps
docker logs openclaw-trello-gateway-1
```

Recent failures have been service-health failures after restart, not git drift on the droplet.
When `trello-gateway` is unhealthy, the dependent services (`trello-bridge`, `github-pr-bridge`, `trello-queue-worker`, and `trello-routines`) will not start because compose waits for `trello-gateway` health.

## Required GitHub Actions secrets

The deploy workflow requires:

- `DROPLET_HOST`
- `DROPLET_USER`
- `DROPLET_SSH_KEY`
- `DROPLET_SSH_PORT` (optional)
