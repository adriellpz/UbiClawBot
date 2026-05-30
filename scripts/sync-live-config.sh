#!/usr/bin/env bash
set -euo pipefail
SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n /usr/bin/bash "$SCRIPT" "$@"
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p /root/openclaw/data/config/hooks/transforms
node "$ROOT/scripts/sync-live-config.mjs"
chown -R deploy:deploy /root/openclaw/data/config/hooks
