#!/usr/bin/env bash
# Manual droplet helper: rebuild and recreate trello-gateway only.
# Tracked gateway files are deployed via GitHub Actions; this script does not touch .env.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ ! -f trello-gateway/.env ]]; then
  echo "trello-gateway/.env missing — copy from trello-gateway/.env.example and fill in secrets." >&2
  exit 1
fi

chmod 700 trello-gateway/trello_gateway.mjs
docker compose build trello-gateway
docker compose up -d --force-recreate trello-gateway
docker compose ps trello-gateway
