#!/usr/bin/env bash
# Remote deploy body — copied to droplet by deploy-droplet.yml and executed over SSH.
# Kept out of inline workflow YAML so appleboy/ssh-action does not mangle multiline bash.
set -eu
: "${HOME:?}"
OPENCLAW_ROOT="${HOME}/openclaw"

smoke_required_file() {
  local rel="$1"
  if [ ! -f "${OPENCLAW_ROOT}/${rel}" ]; then
    echo "smoke failed: missing file ${rel}" >&2
    exit 1
  fi
}

smoke_http() {
  local url="$1"
  local label="$2"
  for attempt in $(seq 1 30); do
    if curl -fsS "$url" >/dev/null; then
      return 0
    fi
    if [ "$attempt" -eq 30 ]; then
      echo "smoke failed: ${label} ${url}" >&2
      exit 1
    fi
    sleep 2
  done
}

smoke_required_env() {
  local svc="$1"
  shift
  local var val
  for var in "$@"; do
    val="$(docker compose exec -T "$svc" sh -c "printenv ${var} || true" 2>/dev/null | tr -d '\r\n')"
    if [ -z "$val" ]; then
      echo "smoke failed: service ${svc} is missing required env ${var} — check ${OPENCLAW_ROOT}/.env" >&2
      exit 1
    fi
  done
}

smoke_public_route() {
  local host="$1"
  local pathq="$2"
  local label="$3"
  local code
  for attempt in $(seq 1 30); do
    code="$(curl -s -o /dev/null -m 8 -w '%{http_code}' \
      --resolve "${host}:443:127.0.0.1" \
      -X POST "https://${host}${pathq}" \
      -H 'Content-Type: application/json' -d '{}' 2>/dev/null || true)"
    code="${code:-000}"
    case "$code" in
      000|5*) ;;
      *) return 0 ;;
    esac
    if [ "$attempt" -eq 30 ]; then
      echo "smoke failed: ${label} https://${host}${pathq} returned ${code} (upstream unreachable — likely a stale github-pr-bridge netns; recreate it alongside openclaw-gateway)" >&2
      exit 1
    fi
    sleep 2
  done
}

write_deployed_revision() {
  local deployed_at
  deployed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '%s\n' \
    '{' \
    "  \"gitSha\": \"${GITHUB_SHA:-unknown}\"," \
    "  \"gitRef\": \"${GITHUB_REF:-unknown}\"," \
    "  \"deployedAt\": \"${deployed_at}\"," \
    "  \"workflow\": \"deploy-droplet.yml\"," \
    "  \"manifestVersion\": 1" \
    '}' \
    > "${OPENCLAW_ROOT}/deployed-revision.json"
}

install_bridge_watchdog_cron() {
  local tmp
  tmp="$(mktemp)"
  crontab -l 2>/dev/null | grep -v "monitor-github-pr-bridge.sh" >"$tmp" || true
  printf '%s\n' "*/3 * * * * ${OPENCLAW_ROOT}/scripts/monitor-github-pr-bridge.sh >/dev/null 2>&1" >>"$tmp"
  crontab "$tmp"
  rm -f "$tmp"
}

mkdir -p "${OPENCLAW_ROOT}"
cp "${OPENCLAW_ROOT}/.deploy-tmp/Dockerfile.gog" "${OPENCLAW_ROOT}/Dockerfile.gog"
cp "${OPENCLAW_ROOT}/.deploy-tmp/docker-compose.droplet.yml" "${OPENCLAW_ROOT}/docker-compose.yml"
cp "${OPENCLAW_ROOT}/.deploy-tmp-root/Caddyfile.droplet" "${OPENCLAW_ROOT}/Caddyfile.droplet"
mkdir -p "${OPENCLAW_ROOT}/github-pr-bridge"
cp "${OPENCLAW_ROOT}/.deploy-tmp-github-pr-bridge/github-pr-bridge/"* "${OPENCLAW_ROOT}/github-pr-bridge/"
mkdir -p "${OPENCLAW_ROOT}/trello-routines"
cp "${OPENCLAW_ROOT}/.deploy-tmp-trello-routines/trello-routines/"* "${OPENCLAW_ROOT}/trello-routines/"
mkdir -p "${OPENCLAW_ROOT}/trello-pipeline"
cp "${OPENCLAW_ROOT}/.deploy-tmp-trello-pipeline/trello-pipeline/"* "${OPENCLAW_ROOT}/trello-pipeline/"
mkdir -p "${OPENCLAW_ROOT}/scripts/manual"
cp "${OPENCLAW_ROOT}/.deploy-tmp-scripts-manual/scripts/manual/"* "${OPENCLAW_ROOT}/scripts/manual/"
mkdir -p "${OPENCLAW_ROOT}/deploy"
cp "${OPENCLAW_ROOT}/.deploy-tmp-deploy/deploy/manifest.json" "${OPENCLAW_ROOT}/deploy/manifest.json"
mkdir -p "${OPENCLAW_ROOT}/config/live"
cp -r "${OPENCLAW_ROOT}/.deploy-tmp-live-config/config/live/." "${OPENCLAW_ROOT}/config/live/"
cp "${OPENCLAW_ROOT}/.deploy-tmp-ops-scripts/scripts/backup-droplet.sh" "${OPENCLAW_ROOT}/scripts/backup-droplet.sh"
cp "${OPENCLAW_ROOT}/.deploy-tmp-ops-scripts/scripts/monitor-github-pr-bridge.sh" "${OPENCLAW_ROOT}/scripts/monitor-github-pr-bridge.sh"
cp "${OPENCLAW_ROOT}/.deploy-tmp-ops-scripts/scripts/sync-live-config.sh" "${OPENCLAW_ROOT}/scripts/sync-live-config.sh"
cp "${OPENCLAW_ROOT}/.deploy-tmp-ops-scripts/scripts/sync-live-config.mjs" "${OPENCLAW_ROOT}/scripts/sync-live-config.mjs"
cp "${OPENCLAW_ROOT}/.deploy-tmp-ops-scripts/scripts/sanitize-live-config.mjs" "${OPENCLAW_ROOT}/scripts/sanitize-live-config.mjs"
cp "${OPENCLAW_ROOT}/.deploy-tmp-ops-scripts/scripts/deploy-droplet-remote.sh" "${OPENCLAW_ROOT}/scripts/deploy-droplet-remote.sh"
chmod +x "${OPENCLAW_ROOT}/scripts/backup-droplet.sh" "${OPENCLAW_ROOT}/scripts/monitor-github-pr-bridge.sh" "${OPENCLAW_ROOT}/scripts/sync-live-config.sh" "${OPENCLAW_ROOT}/scripts/deploy-droplet-remote.sh"
mkdir -p "${OPENCLAW_ROOT}/data/agent-runtime/cheryl/wiki-maintainer"
cp -r "${OPENCLAW_ROOT}/.deploy-tmp-cheryl-wiki-maintainer/runtime/cheryl/wiki-maintainer/." "${OPENCLAW_ROOT}/data/agent-runtime/cheryl/wiki-maintainer/"
find "${OPENCLAW_ROOT}/data/agent-runtime/cheryl/wiki-maintainer/bin" -name '*.mjs' -exec chmod +x {} + 2>/dev/null || true

install_bridge_watchdog_cron

mkdir -p "${OPENCLAW_ROOT}/trello-gateway"
for f in Dockerfile deploy.sh trello_card_contract.mjs trello_gateway.mjs trello_transition_matrix.csv .env.example; do
  cp "${OPENCLAW_ROOT}/.deploy-tmp-trello-gateway/trello-gateway/$f" "${OPENCLAW_ROOT}/trello-gateway/$f"
done
chmod 700 "${OPENCLAW_ROOT}/trello-gateway/trello_gateway.mjs"
chmod +x "${OPENCLAW_ROOT}/trello-gateway/deploy.sh"

smoke_required_file "scripts/manual/backfill_routine_card_due.mjs"
smoke_required_file "scripts/manual/backfill_calendar_links_to_description.mjs"
smoke_required_file "trello-routines/ensure_routines.mjs"
smoke_required_file "trello-pipeline/server.mjs"
smoke_required_file "trello-gateway/trello_gateway.mjs"
smoke_required_file "github-pr-bridge/server.mjs"
smoke_required_file "docker-compose.yml"
smoke_required_file "deploy/manifest.json"
smoke_required_file "config/live/openclaw.json"
smoke_required_file "scripts/sync-live-config.sh"
smoke_required_file "scripts/monitor-github-pr-bridge.sh"
smoke_required_file "data/agent-runtime/cheryl/wiki-maintainer/bin/wiki-log-preflight.mjs"

cd "${OPENCLAW_ROOT}"
bash scripts/sync-live-config.sh

cd "${OPENCLAW_ROOT}"
docker compose build openclaw-gateway trello-gateway
docker compose up -d --force-recreate openclaw-gateway openclaw-cli trello-bridge github-pr-bridge trello-gateway trello-queue-worker trello-routines

smoke_http "http://127.0.0.1:18792/healthz" "trello-gateway"
smoke_http "http://127.0.0.1:${GITHUB_PR_BRIDGE_PORT:-19091}/healthz" "github-pr-bridge"
smoke_http "http://127.0.0.1:18990/health" "trello-bridge"

PUBLIC_HOST="$(awk '!/^#/ && /\{[ \t]*$/ {sub(/[ \t]*\{[ \t]*$/,""); print; exit}' "${OPENCLAW_ROOT}/Caddyfile.droplet")"
smoke_public_route "${PUBLIC_HOST:-ai.sonofwolf.org}" "/github-pr" "github-pr public route"

smoke_required_env trello-bridge TRELLO_API_KEY TRELLO_API_TOKEN
smoke_required_env trello-gateway TRELLO_API_KEY TRELLO_API_TOKEN

write_deployed_revision
cat "${OPENCLAW_ROOT}/deployed-revision.json"

if cmp -s "${OPENCLAW_ROOT}/Caddyfile.droplet" /etc/caddy/Caddyfile 2>/dev/null; then
  echo "Caddyfile unchanged — skipping validate/install/reload"
else
  sudo caddy validate --config "${OPENCLAW_ROOT}/Caddyfile.droplet"
  sudo install -m 0644 "${OPENCLAW_ROOT}/Caddyfile.droplet" /etc/caddy/Caddyfile
  if ! sudo systemctl reload caddy; then
    echo "caddy reload failed; journal follows, then restart" >&2
    sudo journalctl -u caddy.service -n 30 --no-pager >&2 || true
    sudo systemctl restart caddy
  fi
fi
docker compose ps
