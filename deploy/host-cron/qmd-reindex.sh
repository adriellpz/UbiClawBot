#!/bin/sh
# Reindex all qmd collections (wiki + openclaw-docs) from the droplet host.
#
# Installed at /root/openclaw/bin/qmd-reindex.sh and driven by
# /etc/cron.d/openclaw-qmd-reindex (3x/day, UTC). qmd lives inside the
# gateway container; its index + collection config are under the node
# user's home (/home/node/.openclaw/qmd, index at ~/.cache/qmd).
#
# `qmd update` re-scans changed markdown (cheap); `qmd embed` fills any
# pending vectors. flock keeps slow CPU-only embeds from overlapping the
# next scheduled run. Covers both the wiki collection (curator-filed pages)
# and the openclaw-docs collection (platform docs mirror).
#
# Cache path dependency: the container path /home/node/.cache/qmd is
# bind-mounted from the host via $OPENCLAW_QMD_CACHE_DIR (default:
# /home/deploy/openclaw/data/qmd-cache) in docker-compose.yml. If that
# default changes, this script's embed output will land in the old location
# and the index will appear empty. Keep the compose default and this note
# in sync.

CONTAINER=openclaw-openclaw-gateway-1
LOCKFILE=/var/run/openclaw-qmd-reindex.lock

# Non-blocking lock: if a previous (slow) run is still embedding, skip.
exec 9>"$LOCKFILE" || exit 0
if ! flock -n 9; then
  echo "[$(date -u +%FT%TZ)] skip: previous reindex still running"
  exit 0
fi

echo "[$(date -u +%FT%TZ)] qmd reindex start"
docker exec "$CONTAINER" sh -lc 'cd /home/node/.openclaw/qmd && qmd update && qmd embed --max-docs-per-batch 100'
rc=$?
echo "[$(date -u +%FT%TZ)] qmd reindex done rc=$rc"
exit "$rc"
