# trello-gateway

Isolated Docker service that holds **all Trello API credentials**. OpenClaw agent containers talk to it over HTTP with `TRELLO_GATEWAY_KEY` — they never see raw Trello tokens.

## Layout

| File | Purpose |
|------|---------|
| `trello_gateway.mjs` | Gateway daemon (validated ops + transition matrix) |
| `trello_transition_matrix.csv` | Allowed/forbidden list moves loaded by the gateway |
| `Dockerfile` | `node:22-alpine` image |
| `.env.example` | Placeholder env — copy to `.env` on the droplet |
| `deploy.sh` | Manual rebuild/recreate on the droplet |

## Source of truth

`UbiClawBot/trello-gateway/` is the canonical home for both gateway deploy artifacts:

- `trello-gateway/trello_gateway.mjs`
- `trello-gateway/trello_transition_matrix.csv`

Other repos should reference these files, not keep their own tracked copies.

## Droplet paths

- Deploy dir: `/home/deploy/openclaw/trello-gateway/`
- Secrets: `/home/deploy/openclaw/trello-gateway/.env` (host-only, gitignored)
- Docker DNS: `http://trello-gateway:18792`
- Host SSH check: `curl http://127.0.0.1:18792/healthz`

## First-time setup (droplet)

```bash
cd /home/deploy/openclaw/trello-gateway
cp .env.example .env
chmod 600 .env
# edit .env with real Trello keys and GATEWAY_KEY
chmod 700 trello_gateway.mjs
cd /home/deploy/openclaw
docker compose build trello-gateway
docker compose up -d trello-gateway
```

Set matching `TRELLO_GATEWAY_KEY` in `/home/deploy/openclaw/.env` for agent containers.

## Updates

- **Script/matrix only:** GitHub deploy copies tracked files and restarts services (volume mounts pick up changes).
- **Manual:** `./trello-gateway/deploy.sh` from `/home/deploy/openclaw`.
- **Matrix edits:** restart `trello-gateway` after CSV changes.
