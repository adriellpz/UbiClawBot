# Deploy repo layout (OpenClaw as a versioned dependency)

This repository holds **your** configuration and Docker/Caddy glue. **OpenClaw itself** is not copied into git here; you run it via the **published container image** pinned in `.env`.

## What is tracked

| Path | Purpose |
|------|---------|
| `.env.example` | Image pin (`OPENCLAW_IMAGE`) and compose-related variables — copy to `.env`. |
| `config/openclaw.example.json` | Safe template — copy to `config/openclaw.json` on each machine and replace placeholders. |
| `workspace/Dockerfile.gog` | Extends upstream image (browser deps + `gog`). |
| `workspace/docker-compose.droplet.yml` | Compose definition; uses `OPENCLAW_IMAGE` from `.env`. |
| `Caddyfile.droplet` | Reverse proxy / TLS (example for your VPS). |

## What is intentionally not tracked

| Path | Reason |
|------|--------|
| `openclaw-repo/` | Upstream source clone — optional dev checkout; use image pin for production. |
| `config/openclaw.json` | Contains secrets; created locally from `openclaw.example.json`. |
| `workspace/*` (except the two deploy files) | Agent workspace and personal files. |

## First-time setup (new machine)

1. Copy env: `cp .env.example .env` and set secrets / paths (`OPENCLAW_GATEWAY_TOKEN`, `OPENCLAW_IMAGE`, etc.).
2. Copy config: `cp config/openclaw.example.json config/openclaw.json` and edit (tokens, domains, channels).
3. Build and run from `workspace/` (or symlink `docker-compose.yml`):

   ```bash
   cd workspace
   docker compose -f docker-compose.droplet.yml --env-file ../.env build
   docker compose -f docker-compose.droplet.yml --env-file ../.env up -d
   ```

   Adjust `--env-file` if your `.env` lives elsewhere (e.g. `/root/openclaw/.env` on the droplet).

## Updating OpenClaw later

1. Check [OpenClaw releases](https://github.com/openclaw/openclaw/releases) (or your registry tags).
2. Bump **`OPENCLAW_IMAGE`** in `.env` to the new tag (same tag in `workspace/Dockerfile.gog` **ARG `BASE_IMAGE`** default if you rely on it).
3. Rebuild the derived image and restart:

   ```bash
   cd workspace
   docker compose -f docker-compose.droplet.yml build --no-cache openclaw-gateway
   docker compose -f docker-compose.droplet.yml up -d
   ```

4. Read upstream release notes for **config migrations**; merge changes into `config/openclaw.json` manually (keep `openclaw.example.json` updated when you adopt new options worth documenting).

## Optional: fork upstream for patches

If you need to change OpenClaw’s source, fork **openclaw/openclaw** on GitHub, clone that fork elsewhere, add **`upstream`** = `https://github.com/openclaw/openclaw.git`, and merge/rebase when you want updates. This deploy repo still only needs the **image tag** unless you build your own images from the fork.
