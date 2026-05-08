# Secrets Operations

Long-term baseline for this deployment:
- Keep real secrets only on the droplet.
- Keep placeholders only in git (`.env.example`, `config/openclaw.example.json`).
- Lock down file permissions and back up encrypted snapshots.

## Files

- Host runtime env: `/root/openclaw/.env`
- Host runtime config dir: `/root/openclaw/data/config`
- Runtime OpenClaw config: `/root/openclaw/data/config/openclaw.json`

## First-time setup (droplet)

```bash
mkdir -p /root/openclaw/data/config /root/openclaw/data/workspace
touch /root/openclaw/.env
chmod 700 /root/openclaw/data/config /root/openclaw/data/workspace
chmod 600 /root/openclaw/.env /root/openclaw/data/config/openclaw.json
```

## Deploy updated config from local machine

```powershell
scp "c:\Projects\openclaw-sandbox\config\openclaw.json" "root@134.209.38.222:/root/openclaw/data/config/openclaw.json"
ssh root@134.209.38.222 "cd /root/openclaw && docker compose restart openclaw-gateway"
```

## Add/rotate env secrets safely (droplet)

```bash
vi /root/openclaw/.env
cd /root/openclaw
docker compose up -d --force-recreate openclaw-gateway openclaw-cli
```

## Verify what is loaded

```bash
cd /root/openclaw
docker compose logs openclaw-gateway --tail 50
docker exec openclaw-openclaw-gateway-1 sh -lc 'echo "config dir: $XDG_CONFIG_HOME"; test -f /home/node/.openclaw/openclaw.json && echo ok'
```

## GitHub CLI inside OpenClaw (Docker)

Host `gh` login does **not** apply to the gateway container. The image includes `gh`; auth uses **`GITHUB_TOKEN`** or **`GH_TOKEN`** in `/root/openclaw/.env` (wired through Compose — same pattern as other secrets). OpenClaw documents env precedence in `docs/help/environment.md`; Copilot-related docs reference `GH_TOKEN` / `GITHUB_TOKEN`.

After setting the token, recreate the gateway so the process inherits env:

```bash
vi /root/openclaw/.env   # add GITHUB_TOKEN=... or GH_TOKEN=...
cd /root/openclaw
docker compose up -d --force-recreate openclaw-gateway openclaw-cli
```

Verify (token value must not print):

```bash
docker compose exec openclaw-gateway gh auth status
```

