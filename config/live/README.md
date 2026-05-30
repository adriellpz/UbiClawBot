# Live OpenClaw config (sanitized)

Tracked copy of production **structure** — not secrets. Real tokens stay on the droplet only.

| File | Applied to (on sync) |
|------|----------------------|
| `openclaw.json` | `/root/openclaw/data/config/openclaw.json` (secrets preserved) |
| `cron/jobs.json` | `/root/openclaw/data/config/cron/jobs.json` (job `state` preserved) |
| `hooks/transforms/*.mjs` | `/root/openclaw/data/config/hooks/transforms/` (legacy; Gmail filter now lives in `gmail-hook-bridge`) |

## Refresh from droplet

```bash
ssh myserver 'cat /root/openclaw/data/config/openclaw.json' \
  | node scripts/sanitize-live-config.mjs openclaw \
  > config/live/openclaw.json

ssh myserver 'cat /root/openclaw/data/config/cron/jobs.json' \
  | node scripts/sanitize-live-config.mjs cron \
  > config/live/cron/jobs.json
```

Commit, merge to `main`, deploy applies via `scripts/sync-live-config.sh`.

## Hook bridges (Gmail + GOG auth canary)

Gmail and GOG auth failure intake no longer use `hooks.mappings` agent routes. gog posts to bridge URLs configured in `hooks.gmail.hookUrl`:

| Bridge | Port | Path | Role |
|--------|------|------|------|
| `gmail-hook-bridge` | 19092 | `/hooks/gmail` | Adriel-only sender filter → Trello card → Ubi wake |
| `gog-canary-bridge` | 19093 | `/healthz` | Periodic `gog auth list`; on failure → Trello card → Ubi wake |

Keep `"mappings": []` for Gmail. Do not re-add inline gmail agent mappings or transforms.

## Secrets live only in the droplet `.env` — do not strip them

This workflow tracks **structure**, never secrets. The real tokens live solely in
`/home/deploy/openclaw/.env` on the droplet, which **nothing here syncs or backs up
automatically**. When hand-editing that file (e.g. during a migration), keep every
secret the services need — `.env.example` is the source of truth for which keys are
required and why.

In particular `TRELLO_API_KEY` / `TRELLO_API_TOKEN` are **required by the trello-bridge**
(its webhook-miss fallback poll calls the Trello API directly; `TRELLO_GATEWAY_*` does
not cover it). Dropping them disables the poll silently and strands cards mid-transition
(this happened once — cards stuck in Reschedule). The deploy now smoke-checks these are
present on `trello-bridge` and `trello-gateway` and fails loudly if not.
