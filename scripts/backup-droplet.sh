#!/usr/bin/env bash
# Snapshot droplet state before config changes. Run on the droplet as deploy or root.
set -euo pipefail

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_ROOT="${1:-/home/deploy/openclaw/backups/$STAMP}"
mkdir -p "$BACKUP_ROOT"

echo "Backing up to $BACKUP_ROOT"

tar -czf "$BACKUP_ROOT/openclaw-config-no-browser.tgz" \
  --exclude='browser' \
  -C /root/openclaw/data config

tar -czf "$BACKUP_ROOT/agent-vault.tgz" \
  -C /home/deploy/openclaw/data agent-vault

if [[ -d /home/deploy/openclaw/data/agent-runtime/cheryl/wiki-maintainer ]]; then
  tar -czf "$BACKUP_ROOT/cheryl-wiki-maintainer-runtime.tgz" \
    -C /home/deploy/openclaw/data/agent-runtime/cheryl wiki-maintainer
fi
if [[ -d /home/deploy/openclaw/tools/agent-workspace-vault ]]; then
  tar -czf "$BACKUP_ROOT/tools-agent-workspace-vault.tgz" \
    -C /home/deploy/openclaw/tools agent-workspace-vault
fi

cp /home/deploy/openclaw/.env "$BACKUP_ROOT/deploy.env"
[[ -f /home/deploy/openclaw/trello-gateway/.env ]] && \
  cp /home/deploy/openclaw/trello-gateway/.env "$BACKUP_ROOT/trello-gateway.env"

cat > "$BACKUP_ROOT/README.txt" <<EOF
Droplet backup $STAMP

Files:
- openclaw-config-no-browser.tgz  → /root/openclaw/data/config (no browser profile)
- agent-vault.tgz                 → /home/deploy/openclaw/data/agent-vault
- cheryl-wiki-maintainer-runtime.tgz → data/agent-runtime/cheryl/wiki-maintainer (if present)
- tools-agent-workspace-vault.tgz → legacy vault tools path (deprecated; if present)
- deploy.env, trello-gateway.env  → secrets (private)

Restore:
  sudo tar -xzf openclaw-config-no-browser.tgz -C /root/openclaw/data
  sudo tar -xzf agent-vault.tgz -C /home/deploy/openclaw/data
  sudo chown -R deploy:deploy /home/deploy/openclaw/data/agent-vault
EOF

ls -lh "$BACKUP_ROOT"
du -sh "$(dirname "$BACKUP_ROOT")"
