# AGENTS.md

## Cursor Cloud specific instructions

### Overview

This is a **deployment/configuration repository** for [OpenClaw](https://github.com/openclaw/openclaw), an AI agent gateway platform. OpenClaw runs as a **pinned container image** (`ghcr.io/openclaw/openclaw:2026.5.7`); the upstream source is not in this repo. See `DEPLOY.md` for full setup docs.

### Architecture

- **Single required service**: `openclaw-gateway` Docker container (HTTP/WS on port 18789, bridge on 18790)
- **Optional service**: `openclaw-cli` (interactive CLI sharing the gateway network)
- **Caddy**: Only needed for production TLS termination, not local dev

### Running the gateway

1. Ensure Docker is running (`sudo dockerd` if needed).
2. The `.env` file must exist at repo root (copy from `.env.example`; set `OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_CONFIG_DIR`, `OPENCLAW_WORKSPACE_DIR`).
3. The config file `config/openclaw.json` must exist (copy from `config/openclaw.example.json`; replace placeholder tokens). It also needs to be present at `$OPENCLAW_CONFIG_DIR/openclaw.json` inside the host path that gets volume-mounted.
4. Build and run from `workspace/`:
   ```bash
   cd workspace
   docker compose -f docker-compose.droplet.yml --env-file ../.env build
   docker compose -f docker-compose.droplet.yml --env-file ../.env up -d openclaw-gateway
   ```
5. Health check: `curl http://127.0.0.1:18789/healthz` should return `{"ok":true,"status":"live"}`.
6. Control UI: open `http://127.0.0.1:18789/` in a browser and authenticate with `OPENCLAW_GATEWAY_TOKEN`.

### Gotchas

- The gateway has a **240-second health start period** — Docker won't mark it healthy until plugins finish loading.
- Gmail-watcher errors at startup are expected if Google OAuth credentials aren't configured.
- For the chat to actually respond, at least one LLM provider (OpenAI, Ollama) must have a valid API key configured in `config/openclaw.json`. Without an API key, sending a chat message returns "No API key found for provider" — the gateway itself is still healthy.
- For local dev, set `gateway.controlUi.allowInsecureAuth: true` and `dangerouslyDisableDeviceAuth: true` in `openclaw.json` to bypass device pairing.
- When running Docker-in-Docker (e.g., in a Cloud Agent VM), you need `fuse-overlayfs` as the storage driver and `iptables-legacy` for networking.

### No lint/test/build

This repo has no source code, package manager, linter, test suite, or build step — it is infrastructure glue around a pre-built container image. The "build" is `docker compose build` and the "run" is `docker compose up`.
