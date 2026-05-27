# Trello Routines

`trello-routines/` is the repo-owned home for the unattended routines job that materializes and maintains recurring Trello/calendar work.

## Runtime contract

- the compose service runs from `/opt/trello-routines`
- Trello access goes through `TRELLO_GATEWAY_URL` and `TRELLO_GATEWAY_KEY`
- calendar reads and writes go through `gog`
- loop heartbeat is written to `${TRELLO_ROUTINES_STATE_DIR:-/var/lib/trello-routines}/last_run.json`

## Main responsibilities

- `ensure_routines.mjs`
- `ensure_routines_logic.mjs`
- `routine_manifest.json`
- `start_routines_loop.sh`

## Local checks

```bash
node --test trello-routines/ensure_routines_logic.test.mjs trello-routines/ensure_routines.test.mjs trello-routines/routine_manifest.test.mjs
node --check trello-routines/ensure_routines.mjs
```
