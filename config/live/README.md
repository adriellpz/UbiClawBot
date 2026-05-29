# Live OpenClaw config (sanitized)

Tracked copy of production **structure** — not secrets. Real tokens stay on the droplet only.

| File | Applied to (on sync) |
|------|----------------------|
| `openclaw.json` | `/root/openclaw/data/config/openclaw.json` (secrets preserved) |
| `cron/jobs.json` | `/root/openclaw/data/config/cron/jobs.json` (job `state` preserved) |
| `hooks/transforms/*.mjs` | `/root/openclaw/data/config/hooks/transforms/` |

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
