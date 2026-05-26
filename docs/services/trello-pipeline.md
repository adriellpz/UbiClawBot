# Trello Pipeline

`trello-pipeline` is the repo-owned home for the webhook-driven Trello production pipeline.

## Runtime Contract

- Production runs the webhook ingress and queue worker from `/opt/trello-pipeline`.
- The `trello-bridge` service runs `server.mjs`.
- The `trello-queue-worker` service runs `start_queue_worker.mjs`, which supervises `trello_queue_worker.mjs`.
- Durable pipeline state lives in `TRELLO_PIPELINE_STATE_DIR` and is distinct from agent workspace state.
- Trello access goes through `TRELLO_GATEWAY_URL` and `TRELLO_GATEWAY_KEY`.
- Calendar reads and writes go through `gog` using the mounted OpenClaw config home for OAuth state.

## Canonical Files

- `trello-pipeline/server.mjs`
- `trello-pipeline/trello_queue_worker.mjs`
- `trello-pipeline/start_queue_worker.mjs`
- deterministic handlers such as `handle_reschedule.mjs`, `trello_done_adjust_calendar.mjs`, and `trello_missed_adjust_calendar.mjs`

## Deploy Shape

- The deploy workflow copies the tracked directory into `/home/deploy/openclaw/trello-pipeline/`.
- Compose mounts that tracked folder read-only into `/opt/trello-pipeline`.
- Pipeline state is mounted separately from the host state directory.

For the ownership boundary behind this layout, see [Architecture](../architecture/README.md) and [ADR-0001](../adr/0001-trello-pipeline-ownership.md).
