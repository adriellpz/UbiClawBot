# Trello Pipeline

`trello-pipeline/` is the repo-owned home for the production webhook ingress, queue worker, and deterministic Trello/calendar handlers.

## Runtime contract

- `trello-bridge` and `trello-queue-worker` run from `/opt/trello-pipeline`
- durable state lives at `${TRELLO_PIPELINE_STATE_DIR:-/var/lib/trello-pipeline}`
- Trello access goes through `TRELLO_GATEWAY_URL` and `TRELLO_GATEWAY_KEY`
- optional fallback poll in `server.mjs` reads `TRELLO_API_KEY` / `TRELLO_API_TOKEN` from `trello-gateway/.env` via `TRELLO_PIPELINE_ENV_FILE` (compose mounts it at `/opt/trello-gateway/.env`)
- calendar reads and writes go through `gog` using the mounted OpenClaw config home

## Main responsibilities

- `/trello` webhook intake in `server.mjs`
- pending queue processing in `trello_queue_worker.mjs`
- deterministic handlers such as `handle_reschedule.mjs`, `trello_done_adjust_calendar.mjs`, and `trello_missed_adjust_calendar.mjs`

## Local checks

```bash
node --test trello-pipeline/server.test.mjs trello-pipeline/queue_worker.test.mjs trello-pipeline/smoke.test.mjs
node --check trello-pipeline/server.mjs trello-pipeline/trello_queue_worker.mjs trello-pipeline/handle_reschedule.mjs
```
