#!/bin/sh
# Runtime watchdog for network-mode bridge containers.
#
# Several containers run with `network_mode: service:openclaw-gateway`, so they share
# the gateway container's network namespace. If the gateway is recreated out of band
# (a manual restart, a partial `compose up`, anything that isn't a full deploy) the
# bridge containers are left pinned to the now-dead namespace. Their own Docker
# healthcheck still passes — they answer on 127.0.0.1 inside that dead namespace — but
# Caddy gets a connection reset and returns 502, so webhook-based ops are silently
# dropped.
#
# The deploy workflow's smoke_public_route check only covers deploys. This watchdog
# covers the between-deploys window. A plain `docker restart` reuses the stale netns
# reference, so recovery requires `compose up --force-recreate`, which re-resolves
# `service:openclaw-gateway` to the live gateway container.
#
# Runs from the deploy user's crontab. deploy is in the `docker` group, so this needs
# no root and mounts no docker socket. Healthy runs exit silently (no log churn);
# only detections/actions are logged as JSONL.
#
# Required env: SERVICE (compose service name), HEALTH_PORT (port number).
# Optional env: ROUTE (Caddy path, for public-probe mode), HEALTH_PATH (default /healthz),
#   MONITOR_LOG, MONITOR_TAG.
# PROBE_MODE: "public" (via Caddy, HTTP status check) or "local" (direct port hit).
set -eu

# --- service identity (required) ---
SERVICE="${SERVICE:?SERVICE required}"
HEALTH_PORT="${HEALTH_PORT:?HEALTH_PORT required}"
PROBE_MODE="${PROBE_MODE:-public}"
ROUTE="${ROUTE:-}"
HEALTH_PATH="${HEALTH_PATH:-/healthz}"
MONITOR_TAG="${MONITOR_TAG:-${SERVICE}}"

# --- paths ---
OPENCLAW_ROOT="${OPENCLAW_ROOT:-/home/deploy/openclaw}"
CADDYFILE="${CADDYFILE:-$OPENCLAW_ROOT/Caddyfile.droplet}"
GATEWAY_CONTAINER="${GATEWAY_CONTAINER:-openclaw-openclaw-gateway-1}"
STATE_DIR="${STATE_DIR:-$OPENCLAW_ROOT/data/trello-pipeline}"
LOG="${MONITOR_LOG:-$STATE_DIR/${SERVICE}-monitor.log}"
DRY_RUN="${DRY_RUN:-0}"

mkdir -p "$STATE_DIR" 2>/dev/null || true

log() {
  printf '{"ts":"%s","svc":"%s",%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$MONITOR_TAG" "$1" >> "$LOG" 2>/dev/null || true
}

# Single-flight: never let two runs recreate the same bridge at once.
LOCKFILE="$STATE_DIR/${SERVICE}-monitor.lock"
if command -v flock >/dev/null 2>&1; then
  exec 9>"$LOCKFILE" 2>/dev/null && flock -n 9 || exit 0
fi

# --- probe helpers ---

probe_public() {
  # Probe via Caddy -> docker-proxy -> bridge. --resolve pins SNI to loopback so
  # we exercise the full Caddy chain without depending on public DNS / hairpin NAT.
  local host
  host="${1:-}"
  if [ -z "$host" ]; then
    DEFAULT_HOST="${DEFAULT_HOST:-ai.sonofwolf.org}"
    if [ -r "$CADDYFILE" ]; then
      host="$(awk '!/^#/ && /\{[ \t]*$/ {sub(/[ \t]*\{[ \t]*$/,""); print; exit}' "$CADDYFILE" 2>/dev/null || true)"
    fi
    if [ -z "$host" ]; then
      log "\"action\":\"caddyfile_host_fallback\",\"caddyfile\":\"${CADDYFILE}\",\"host\":\"${DEFAULT_HOST}\""
      host="$DEFAULT_HOST"
    fi
  fi
  local code
  code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' \
    --resolve "${host}:443:127.0.0.1" \
    -X POST "https://${host}${ROUTE}" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

probe_local() {
  # Direct localhost healthcheck hit.
  local code
  code="$(curl -s -o /dev/null -m 5 -w '%{http_code}' \
    "http://127.0.0.1:${HEALTH_PORT}${HEALTH_PATH}" 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

probe() {
  if [ "$PROBE_MODE" = "local" ]; then
    probe_local
  else
    probe_public "$@"
  fi
}

reachable() {
  # For public mode: any non-5xx/non-000 (e.g. a 401 signature reject) proves the
  # request reached the bridge process. 000 = connection failure, 5xx = Caddy upstream
  # error / stale netns.
  # For local mode: 200 only; a dead-namespace container may still answer on 127.0.0.1
  # inside the zombie netns, so local probe is less reliable for nsm detection — but
  # it's the best we can do for internal-only services (gog-canary-bridge).
  local code
  code="$(probe)"
  case "$PROBE_MODE" in
    local)
      [ "$code" = "200" ]
      return
      ;;
    *)
      case "$code" in
        000|5*) return 1 ;;
        *) return 0 ;;
      esac
      ;;
  esac
}

# --- main ---

reachable && exit 0
sleep 5; reachable && exit 0
sleep 5; reachable && exit 0

code="$(probe)"
log "\"action\":\"detected_unreachable\",\"code\":\"${code}\",\"probe_mode\":\"${PROBE_MODE}\""

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
