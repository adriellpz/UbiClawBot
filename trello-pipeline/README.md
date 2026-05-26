# trello-pipeline

Repo-owned home for the remaining Trello production pipeline after the routines slice.

This directory is the canonical source for:

- `server.mjs` webhook ingress for `/trello`
- `trello_queue_worker.mjs`
- `start_queue_worker.mjs`
- deterministic calendar handlers such as `handle_reschedule.mjs`, `trello_done_adjust_calendar.mjs`, and `trello_missed_adjust_calendar.mjs`
- shared pipeline helpers such as `calendar_lookup.mjs` and `trello_card_calendar_desc.mjs`

## Runtime contract

- Production runs `trello-bridge` and `trello-queue-worker` from `/opt/trello-pipeline`.
- Durable state lives in `${TRELLO_PIPELINE_STATE_DIR:-/var/lib/trello-pipeline}`.
- Trello access goes through `TRELLO_GATEWAY_URL` + `TRELLO_GATEWAY_KEY`.
- Calendar reads and writes go through `gog` using the mounted OpenClaw config home for OAuth state.

## Local checks

```bash
node --test trello-pipeline/server.test.mjs trello-pipeline/queue_worker.test.mjs trello-pipeline/smoke.test.mjs
node --check trello-pipeline/server.mjs trello-pipeline/trello_queue_worker.mjs trello-pipeline/handle_reschedule.mjs
```
