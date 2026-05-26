# trello-routines

Repo-owned home for the unattended Trello routine materialization job.

This directory is the canonical source for:

- `ensure_routines.mjs`
- `ensure_routines_logic.mjs`
- `routine_manifest.json`
- `start_routines_loop.sh`

## Runtime contract

- Production runs this slice from `/opt/trello-routines` inside the `trello-routines` service.
- Trello access goes through `TRELLO_GATEWAY_URL` + `TRELLO_GATEWAY_KEY`.
- Calendar reads and writes go through `gog` using the mounted OpenClaw config home for OAuth state.
- Loop heartbeat is written to `${TRELLO_ROUTINES_STATE_DIR:-/var/lib/trello-routines}/last_run.json`.

## Local checks

```bash
node --test trello-routines/ensure_routines_logic.test.mjs trello-routines/ensure_routines.test.mjs trello-routines/routine_manifest.test.mjs
node --check trello-routines/ensure_routines.mjs
```
