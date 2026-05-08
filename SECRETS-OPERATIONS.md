# Secrets Operations

Long-term baseline for this deployment:
- Keep real secrets only on the droplet.
- Keep placeholders only in git (`.env.example`, `config/openclaw.example.json`).
- Lock down file permissions and back up encrypted snapshots.

## Files

- Host runtime env: `/home/deploy/openclaw/.env`
- Host runtime config dir: `/home/deploy/openclaw/data/config`
- Runtime OpenClaw config: `/home/deploy/openclaw/data/config/openclaw.json`

## First-time setup (droplet)

```bash
mkdir -p /home/deploy/openclaw/data/config /home/deploy/openclaw/data/workspace
touch /home/deploy/openclaw/.env
chmod 700 /home/deploy/openclaw/data/config /home/deploy/openclaw/data/workspace
chmod 600 /home/deploy/openclaw/.env /home/deploy/openclaw/data/config/openclaw.json
```

## Deploy updated config from local machine

```powershell
scp "<local-repo>/config/openclaw.json" "deploy@<droplet-host>:/home/deploy/openclaw/data/config/openclaw.json"
ssh deploy@<droplet-host> "cd /home/deploy/openclaw && docker compose restart openclaw-gateway"
```

## Add/rotate env secrets safely (droplet)

```bash
vi /home/deploy/openclaw/.env
cd /home/deploy/openclaw
docker compose up -d --force-recreate openclaw-gateway openclaw-cli
```

## Verify what is loaded

```bash
cd /home/deploy/openclaw
docker compose logs openclaw-gateway --tail 50
docker exec openclaw-openclaw-gateway-1 sh -lc 'echo "config dir: $XDG_CONFIG_HOME"; test -f /home/node/.openclaw/openclaw.json && echo ok'
```

## GitHub CLI inside OpenClaw (Docker)

Host `gh` login does **not** apply to the gateway container. The image includes `gh`; auth uses **`GITHUB_TOKEN`** or **`GH_TOKEN`** in `/home/deploy/openclaw/.env` (wired through Compose — same pattern as other secrets). OpenClaw documents env precedence in `docs/help/environment.md`; Copilot-related docs reference `GH_TOKEN` / `GITHUB_TOKEN`.

After setting the token, recreate the gateway so the process inherits env:

```bash
vi /home/deploy/openclaw/.env   # add GITHUB_TOKEN=... or GH_TOKEN=...
cd /home/deploy/openclaw
docker compose up -d --force-recreate openclaw-gateway openclaw-cli
```

Verify (token value must not print):

```bash
docker compose exec openclaw-gateway gh auth status
```

