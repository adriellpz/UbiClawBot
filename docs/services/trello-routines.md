# Trello Routines

`trello-routines` is the repo-owned home for the unattended scheduled Trello/calendar job.

## Runtime Contract

- Production runs this slice from `/opt/trello-routines` inside the `trello-routines` service.
- Trello access goes through `TRELLO_GATEWAY_URL` and `TRELLO_GATEWAY_KEY`.
- Calendar reads and writes go through `gog` using the mounted OpenClaw config home for OAuth state.
- Loop heartbeat is written to `TRELLO_ROUTINES_STATE_DIR` as `last_run.json`.
- Exact-title routine cards that already exist are skipped rather than rewritten.

## Canonical Files

- `trello-routines/ensure_routines.mjs`
- `trello-routines/ensure_routines_logic.mjs`
- `trello-routines/routine_manifest.json`
- `trello-routines/start_routines_loop.sh`

## Deploy Shape

- The deploy workflow copies the tracked directory into `/home/deploy/openclaw/trello-routines/`.
- Compose mounts that tracked folder read-only into `/opt/trello-routines`.
- Runtime state is mounted separately from the host routines state directory.

For the shared ownership boundary with the webhook pipeline, see [Architecture](../architecture/README.md).
