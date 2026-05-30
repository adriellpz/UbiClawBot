#!/bin/sh
# Runtime watchdog for github-pr-bridge.
#
# github-pr-bridge runs with `network_mode: service:openclaw-gateway`, so it shares
# the gateway container's network namespace. If the gateway is recreated out of band
# (a manual restart, a partial `compose up`, anything that isn't a full deploy) the
# bridge is left pinned to the now-dead namespace. Its own Docker healthcheck still
# passes — it answers on 127.0.0.1:19091 inside that dead namespace — but Caddy gets a
# connection reset and returns 502 on every GitHub PR webhook, so review cards and
# wakes are silently dropped (this is exactly what stranded PR #50).
#
# The deploy workflow's smoke_public_route check only covers deploys. This watchdog
# covers the between-deploys window. A plain `docker restart` reuses the stale netns
# reference, so recovery requires `compose up --force-recreate`, which re-resolves
# `service:openclaw-gateway` to the live gateway container.
#
# Runs from the deploy user's crontab. deploy is in the `docker` group, so this needs
# no root and mounts no docker socket. Healthy runs exit silently (no log churn);
# only detections/actions are logged as JSONL.
set -eu

OPENCLAW_ROOT="${OPENCLAW_ROOT:-/home/deploy/openclaw}"
CADDYFILE="${CADDYFILE:-$OPENCLAW_ROOT/Caddyfile.droplet}"
SERVICE="${SERVICE:-github-pr-bridge}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-openclaw-openclaw-gateway-1}"
ROUTE="${ROUTE:-/github-pr}"
STATE_DIR="${STATE_DIR:-$OPENCLAW_ROOT/data/trello-pipeline}"
LOG="${MONITOR_LOG:-$STATE_DIR/github-pr-bridge-monitor.log}"
DRY_RUN="${DRY_RUN:-0}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() {
  # $1 is a JSON object body (without ts/svc); we wrap it.
  printf '{"ts":"%s","svc":"%s",%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$SERVICE" "$1" >> "$LOG" 2>/dev/null || true
}

# Single-flight: never let two runs recreate the bridge at once.
LOCKFILE="$STATE_DIR/github-pr-bridge-monitor.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE" || true
  flock -n 9 || exit 0
fi

# Site host comes from the Caddyfile so we never hardcode the domain.
host="$(awk '!/^#/ && /\{[ \t]*$/ {sub(/[ \t]*\{[ \t]*$/,""); print; exit}' "$CADDYFILE" 2>/dev/null || true)"
host="${host:-ai.sonofwolf.org}"

probe() {
  # --resolve pins SNI to loopback so we exercise Caddy -> docker-proxy -> bridge
  # without depending on public DNS / hairpin NAT. Prints the HTTP status (000 on
  # connection failure).
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' \
    --resolve "${host}:443:127.0.0.1" \
    -X POST "https://${host}${ROUTE}" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

reachable() {
  # Any non-5xx/non-000 (e.g. a 401 signature reject) proves the request reached the
  # bridge process. 000 = connection failure, 5xx = Caddy upstream error / stale netns.
  case "$(probe)" in
    000|5*) return 1 ;;
    *) return 0 ;;
  esac
}

# Confirm down across a few quick retries so we don't act on a transient blip or a
# gateway that is itself momentarily mid-restart.
reachable && exit 0
sleep 5; reachable && exit 0
sleep 5; reachable && exit 0

code="$(probe)"
log "\"action\":\"detected_unreachable\",\"code\":\"${code}\",\"host\":\"${host}\""

# Don't fight a deploy or a genuine gateway outage: only re-attach when the gateway
# itself is up. If the gateway is down/recreating, recreating the bridge won't help.
gw_state="$(docker inspect -f '{{.State.Status}}' "$GATEWAY_CONTAINER" 2>/dev/null || echo missing)"
if [ "$gw_state" != "running" ]; then
  log "\"action\":\"skip_recreate\",\"reason\":\"gateway_not_running\",\"gateway\":\"${gw_state}\""
  exit 0
fi

if [ "$DRY_RUN" = "1" ]; then
  log "\"action\":\"dry_run_skip_recreate\""
  exit 0
fi

cd "$OPENCLAW_ROOT"
if docker compose up -d --no-deps --force-recreate "$SERVICE" >/dev/null 2>&1; then
  sleep 6
  if reachable; then
    log "\"action\":\"recreated\",\"result\":\"recovered\""
    exit 0
  fi
  log "\"action\":\"recreated\",\"result\":\"still_unreachable\",\"code\":\"$(probe)\""
  exit 1
fi
log "\"action\":\"recreate_failed\""
exit 1
