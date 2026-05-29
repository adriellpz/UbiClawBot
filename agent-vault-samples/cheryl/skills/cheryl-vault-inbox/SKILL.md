---
name: cheryl_vault_inbox
description: Wiki curator — process raw-input/ drops into wiki/ by move/merge. Run on cron when inbox non-empty.
---

# Cheryl — vault inbox (wiki curator)

## When to run

- Cron (~every 15 minutes, America/Denver) or when explicitly asked
- If `raw-input/` has **no** files (except `_failed/`), reply exactly `NO_REPLY`

## Paths

- **Inbox:** `/home/node/.openclaw/agent-vault/raw-input/`
- **Quarantine:** `/home/node/.openclaw/agent-vault/raw-input/_failed/`
- **Corpus:** `/home/node/.openclaw/agent-vault/wiki/`
- **Filing rules doc:** `/home/node/.openclaw/agent-vault/wiki/workflows/raw-input.md`

## Procedure

1. List files in `raw-input/` (top level only). Skip directories except do not enter `_failed/`.
2. For each `.md` (and other text drops if present):
   - Parse `{agent}-{YYYY-MM-DD}-{slug}` from filename when present; use **body content** to pick the final `wiki/` path per `raw-input.md` buckets.
   - Prefer **move** (`mv`) into target path. Create parent dirs as needed.
   - If target exists and the drop is an update: merge (append or section-merge), then remove the inbox copy.
   - If target exists and content duplicates: dedupe, delete inbox copy.
   - If unclear: leave in inbox or move to `_failed/` with reason in a sibling `*.reason.md` or leading HTML comment.
3. Do **not** delete or overwrite operator-only wiki pages without an explicit replace instruction in the drop.
4. Log a one-line summary per file (moved to path, merged, or failed). No Telegram unless operator-facing failure needs attention.

## Smoke / handoff test

- A drop named `ubi-2026-05-30-handoff-test.md` should land under an appropriate `wiki/workflows/` or `wiki/reports/` path and leave inbox empty after success.
