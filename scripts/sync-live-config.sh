#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
sudo mkdir -p /root/openclaw/data/config/hooks/transforms
node "$ROOT/scripts/sync-live-config.mjs"
sudo chown -R deploy:deploy /root/openclaw/data/config/hooks
