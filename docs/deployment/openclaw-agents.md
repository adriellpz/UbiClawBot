# OpenClaw agents (droplet)

Live agent identity, models, and config paths on the production droplet. **Do not trust copies under `/home/deploy/openclaw/data/config/`** — compose mounts **`OPENCLAW_CONFIG_DIR`** (see below).

## Authoritative config

| Item | Path |
|------|------|
| **Host config dir** | `/root/openclaw/data/config` (`OPENCLAW_CONFIG_DIR` in `/home/deploy/openclaw/.env`) |
| **Container mount** | `/home/node/.openclaw` (includes `openclaw.json`, `cron/jobs.json`, agent state) |
| **Template in git** | [`config/openclaw.example.json`](../../config/openclaw.example.json) |

**Stale (ignore / do not edit):** `/home/deploy/openclaw/data/config/openclaw.json` — leftover from pre-cutover layout; **not** mounted by gateway. It incorrectly listed Cheryl on `gpt-5.5`.

Cron jobs (including wiki inbox curator) live at:

`/root/openclaw/data/config/cron/jobs.json` → `/home/node/.openclaw/cron/jobs.json`

## Agent models (live)

Verified against `/root/openclaw/data/config/openclaw.json`:

| OpenClaw ID | Vault folder | Role | Model |
|-------------|--------------|------|-------|
| `main` | `ubi/` | Ubi | `opencode-go/deepseek-v4-flash` |
| `scheduler` | `cheryl/` | Cheryl (scheduling + **wiki curator** cron) | `opencode-go/deepseek-v4-flash` |
| `marcos` | `marcos/` | Marcos | `opencode-go/deepseek-v4-pro` |

**Defaults** in the same file set `primary: openai-codex/gpt-5.5` for agents without an explicit `model` override. All three production agents above **override** the default.

Cheryl’s **wiki inbox cron** is an AI agent turn (`agentTurn` in `jobs.json`): she reads `cheryl-vault-inbox` skill + `wiki/workflows/raw-input.md`, then uses read/write/exec tools to move files. It is **not** a deterministic shell script.

## Wiki curator cron (reference)

- **Job name:** Cheryl vault inbox curator  
- **Schedule:** `*/15 * * * *`, `America/Denver`  
- **Agent:** `scheduler`  
- **Empty inbox:** reply exactly `NO_REPLY`  
- **Skill:** `cheryl/skills/cheryl-vault-inbox/SKILL.md`  
- **Inbox:** `/home/node/.openclaw/agent-vault/raw-input/`  
- **Runtime tools:** `/home/node/.openclaw/agent-runtime/cheryl/wiki-maintainer/bin/` (preflight, index generator)

## Changing a model

1. Edit `config/live/openclaw.json` in git (or refresh from droplet — see [`droplet-backup.md`](./droplet-backup.md)).  
2. Merge to `main`; deploy runs `scripts/sync-live-config.sh` (preserves droplet secrets).  
3. Or on droplet only: edit `/root/openclaw/data/config/openclaw.json`, then refresh `config/live/` before the next commit.
