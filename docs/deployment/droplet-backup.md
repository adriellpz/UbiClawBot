# Droplet backup and config sync

## What lives where

| System | Role |
|--------|------|
| **GitHub (UbiClawBot)** | App code + sanitized operational config (`config/live/`) |
| **Obsidian Sync** | Agent vault content (`data/agent-vault/`) |
| **Droplet** | Secrets (`.env`), runtime state (sessions), live execution |

The droplet is **not** your backup. It is the runtime. GitHub holds the blueprint; Obsidian holds the notes.

## On-droplet snapshots

Backups live at **`/home/deploy/openclaw/backups/<timestamp>/`**.

Create one (on droplet):

```bash
bash /home/deploy/openclaw/scripts/backup-droplet.sh
```

Each snapshot includes:

- `openclaw-config-no-browser.tgz` — `/root/openclaw/data/config` (excludes browser profile)
- `agent-vault.tgz` — vault tree
- `tools-agent-workspace-vault.tgz` — vault helper scripts (if present)
- `deploy.env`, `trello-gateway.env` — **secrets** (never commit)

Restore config + vault:

```bash
cd /home/deploy/openclaw/backups/<timestamp>
sudo tar -xzf openclaw-config-no-browser.tgz -C /root/openclaw/data
sudo tar -xzf agent-vault.tgz -C /home/deploy/openclaw/data
sudo chown -R deploy:deploy /home/deploy/openclaw/data/agent-vault
cd /home/deploy/openclaw && docker compose restart openclaw-gateway
```

## Config sync (GitHub → droplet)

After deploy, `scripts/sync-live-config.sh` merges [`config/live/`](../config/live/) into `/root/openclaw/data/config/`:

- **Preserves** gateway token, hook tokens, Browserbase URL, auth profiles, cron job `state`
- **Updates** agent models, hook mappings, cron job definitions, hook transforms

Manual run:

```bash
ssh myserver 'cd /home/deploy/openclaw && bash scripts/sync-live-config.sh'
```

## Stale paths (ignore)

- `/home/deploy/openclaw/data/config/openclaw.json` — old layout, not mounted by compose

Authoritative config: **`/root/openclaw/data/config/`** (`OPENCLAW_CONFIG_DIR`).

## Vault tools

`agent-workspace-vault` tooling is rsynced separately today:

```bash
rsync -av --delete ../agent-workspace-vault/ myserver:/home/deploy/openclaw/tools/agent-workspace-vault/
```

See [`live-verification.md`](./live-verification.md) for migration notes.
