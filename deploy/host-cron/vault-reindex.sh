#!/bin/sh
# Regenerate vault directory indexes from the droplet host.
#
# Installed at /root/openclaw/bin/vault-reindex.sh and driven by
# /etc/cron.d/openclaw-vault-reindex (every 4h, UTC). The generator
# runs inside the gateway container where the agent vault is mounted
# at /home/node/.openclaw/agent-vault.
#
# flock prevents a slow run from stacking with the next scheduled tick.

CONTAINER=openclaw-openclaw-gateway-1
SCRIPT=/home/node/.openclaw/agent-runtime/cheryl/wiki-maintainer/bin/generate-vault-indexes.mjs
VAULT=/home/node/.openclaw/agent-vault
LOCKFILE=/var/run/openclaw-vault-reindex.lock

exec 9>"$LOCKFILE" || exit 0
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] skip: previous reindex still running"
  exit 0
fi

echo "[$(date -u +%FT%TZ)] vault reindex start"
docker exec "$CONTAINER" node "$SCRIPT" "$VAULT"
rc=$?
echo "[$(date -u +%FT%TZ)] vault reindex done rc=$rc"
exit "$rc"
