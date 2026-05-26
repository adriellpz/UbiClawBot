# Trello Gateway

`trello-gateway` is the isolated service that holds the raw Trello API credentials for the production pipeline.

## Runtime Contract

- Other services talk to it over HTTP using `TRELLO_GATEWAY_URL` and `TRELLO_GATEWAY_KEY`.
- Agent containers and repo-owned workers should not receive raw Trello API tokens in normal production deployment.
- The service exposes `http://trello-gateway:18792` on Docker DNS and `http://127.0.0.1:18792/healthz` on the host.
- The deploy workflow copies tracked gateway artifacts into `/home/deploy/openclaw/trello-gateway/` but leaves `/home/deploy/openclaw/trello-gateway/.env` in place.

## Canonical Files

- `trello-gateway/trello_gateway.mjs`
- `trello-gateway/trello_transition_matrix.csv`
- `trello-gateway/Dockerfile`
- `trello-gateway/deploy.sh`

## Operational Notes

- Restart the service after changing `trello_transition_matrix.csv`.
- `trello_gateway.mjs` is executable in the deploy artifact tree.
- Secrets for this service stay only in `/home/deploy/openclaw/trello-gateway/.env`.

For secret handling, see [Secrets](../deployment/secrets.md).
