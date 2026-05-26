# OpenClaw sandbox (deploy config)

Private deployment configuration and Docker/Caddy layers around **[OpenClaw](https://github.com/openclaw/openclaw)**. OpenClaw ships as a **pinned container image**; this repo does not vendor upstream source (see `.gitignore`).

**Setup and updates:** see [DEPLOY.md](./DEPLOY.md).

## Test gate

Run the static deployment/config validation gate before opening deploy or config PRs:

```bash
npm ci --include=dev
npm test
```

The gate validates JSON and YAML syntax, deploy workflow safety assumptions, compose/Caddy/Dockerfile static checks, trello-gateway directory layout, and the example OpenClaw config placeholders. If Docker Compose or Caddy are installed locally, it also runs their native config validators.

## Trello routines

`trello-routines/` is the repo-owned home for the unattended routines job. In production it runs from the `trello-routines` compose service, talks to Trello only through `trello-gateway`, and uses `gog` for Google Calendar reads/writes.

## Trello pipeline

`trello-pipeline/` is the repo-owned home for the remaining Trello webhook ingress, queue worker, and deterministic calendar handlers. In production the `trello-bridge` and `trello-queue-worker` services now run from `/opt/trello-pipeline` and store durable operational state under the repo-owned pipeline state path instead of the OpenClaw workspace.

