# Trello Gateway

The `trello-gateway` service is the only production service that holds raw Trello API credentials.

## Contract

- other services use `TRELLO_GATEWAY_URL` and `TRELLO_GATEWAY_KEY`
- raw `TRELLO_API_KEY` and `TRELLO_API_TOKEN` stay only in `/home/deploy/openclaw/trello-gateway/.env`
- the gateway enforces transition rules and agent-specific authorization before writing to Trello

## Canonical tracked files

This repo owns the tracked gateway artifacts:

- `trello-gateway/Dockerfile`
- `trello-gateway/deploy.sh`
- `trello-gateway/trello_card_contract.mjs`
- `trello-gateway/trello_gateway.mjs`
- `trello-gateway/trello_transition_matrix.csv`
- `trello-gateway/.env.example`

## Runtime paths

- droplet artifact dir: `/home/deploy/openclaw/trello-gateway`
- container URL from other services: `http://trello-gateway:18792`
- host health check: `http://127.0.0.1:18792/healthz`

`trello_gateway.mjs` imports `trello_card_contract.mjs`, so both files must be present in the deployed artifact set. If the gateway is unhealthy, `trello-bridge`, `github-pr-bridge`, `trello-queue-worker`, and `trello-routines` will stay blocked because they depend on `trello-gateway: service_healthy`.

## Update model

Edit the tracked files in `UbiClawBot`, then deploy through the GitHub Actions workflow or an equivalent manual artifact sync. Do not rely on `git pull` inside `/home/deploy/openclaw`.

Restart or recreate `trello-gateway` after script, matrix, or env changes.
