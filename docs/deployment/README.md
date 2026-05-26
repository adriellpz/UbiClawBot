# Deployment

This repo deploys the OpenClaw runtime and the repo-owned Trello services from GitHub Actions.

## Current Deploy Model

- Deploys are triggered by pushes to `main` or by manual `workflow_dispatch` in `.github/workflows/deploy-droplet.yml`.
- The workflow copies tracked artifacts into `/home/deploy/openclaw`.
- `/home/deploy/openclaw` is the deployed artifact tree, not a pullable git checkout.
- The deploy script rebuilds `openclaw-gateway` and `trello-gateway`, then recreates `openclaw-gateway`, `openclaw-cli`, `trello-bridge`, `github-pr-bridge`, `trello-gateway`, `trello-queue-worker`, and `trello-routines`.
- Do not use `git pull` in `/home/deploy/openclaw` as the normal deploy path unless that model is re-established and verified.

## Tracked Deploy Artifacts

The workflow copies these tracked files into the artifact tree:

- `workspace/Dockerfile.gog`
- `workspace/docker-compose.droplet.yml`
- `Caddyfile.droplet`
- `github-pr-bridge/`
- `trello-pipeline/`
- `trello-routines/`
- `trello-gateway/` tracked files only

Host-only files are intentionally left in place, including `/home/deploy/openclaw/.env`, `/home/deploy/openclaw/trello-gateway/.env`, and runtime data under `/home/deploy/openclaw/data/`.

## Operator Flow

1. Update tracked deploy artifacts in this repo.
2. Run `npm ci --include=dev` and `npm test`.
3. Merge or push to `main`.
4. Let GitHub Actions copy the new artifact set and restart services on the droplet.
5. Verify `docker compose ps` on the host if the deploy needs a spot check.

## Current-State Notes

- OpenClaw itself is not vendored here; production uses the pinned image from `.env`.
- The live deployment contract is defined by `.github/workflows/deploy-droplet.yml`, `workspace/docker-compose.droplet.yml`, and host-only secrets/config files.
- Current ownership boundaries are documented in [Architecture](../architecture/README.md).
- Secrets handling lives in [Secrets](./secrets.md).
