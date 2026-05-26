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

