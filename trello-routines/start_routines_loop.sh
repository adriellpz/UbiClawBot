#!/bin/sh
set -eu

STATE_DIR="${TRELLO_ROUTINES_STATE_DIR:-/var/lib/trello-routines}"
LOOKAHEAD_DAYS="${TRELLO_ROUTINES_LOOKAHEAD_DAYS:-14}"
INTERVAL_SECONDS="${TRELLO_ROUTINES_INTERVAL_SECONDS:-21600}"
HEARTBEAT_FILE="${STATE_DIR}/last_run.json"

mkdir -p "$STATE_DIR"

write_status() {
  status="$1"
  finished_at="$2"
  printf '{"status":"%s","finishedAt":"%s"}\n' "$status" "$finished_at" > "$HEARTBEAT_FILE"
}

while true; do
  started_at="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '{"status":"running","startedAt":"%s"}\n' "$started_at" > "$HEARTBEAT_FILE"

  if node /opt/trello-routines/ensure_routines.mjs --lookahead-days "$LOOKAHEAD_DAYS"; then
    write_status "ok" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  else
    write_status "error" "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  fi

  sleep "$INTERVAL_SECONDS"
done
