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

## Auto-deploy from GitHub (push to `main`)

This repo includes `.github/workflows/deploy-droplet.yml` that deploys on pushes to `main` (and manual `workflow_dispatch`).

It copies these files to the droplet and restarts services:
- `workspace/Dockerfile.gog` -> `/home/deploy/openclaw/Dockerfile.gog`
- `workspace/docker-compose.droplet.yml` -> `/home/deploy/openclaw/docker-compose.yml`
- `Caddyfile.droplet` -> `/home/deploy/openclaw/Caddyfile.droplet`

Then it runs:

```bash
cd /home/deploy/openclaw
docker compose build openclaw-gateway
docker compose up -d --force-recreate openclaw-gateway openclaw-cli
docker compose ps
```

### Required GitHub repo secrets

Set these in **GitHub -> Settings -> Secrets and variables -> Actions**:

- `DROPLET_HOST` (example: `134.209.38.222`)
- `DROPLET_USER` (example: `deploy`)
- `DROPLET_SSH_KEY` (private key content used by Actions runner)
- `DROPLET_SSH_PORT` (optional, defaults to `22`)

Notes:
- Keep runtime secrets (`/home/deploy/openclaw/.env`) only on the droplet.
- This workflow does not overwrite `/home/deploy/openclaw/.env` or `/home/deploy/openclaw/data/*`.

## Optional: fork upstream for patches

If you need to change OpenClaw’s source, fork **openclaw/openclaw** on GitHub, clone that fork elsewhere, add **`upstream`** = `https://github.com/openclaw/openclaw.git`, and merge/rebase when you want updates. This deploy repo still only needs the **image tag** unless you build your own images from the fork.
