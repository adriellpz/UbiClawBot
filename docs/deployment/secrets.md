# Secrets

Keep real secrets on the droplet. Commit placeholders only.

## GitHub Actions secrets

Repository Actions secrets:

- `DROPLET_HOST`
- `DROPLET_USER`
- `DROPLET_SSH_KEY`
- `DROPLET_SSH_PORT` (optional)

These secrets are only for the deploy workflow transport layer. They are not the application runtime secrets.

## Droplet runtime files

Live runtime secrets/config stay here:

- `/home/deploy/openclaw/.env`
- `/home/deploy/openclaw/trello-gateway/.env`
- `/home/deploy/openclaw/data/config/openclaw.json`

The deploy workflow does not overwrite those files.

## Operational rules

- keep `TRELLO_API_KEY` and `TRELLO_API_TOKEN` only in `trello-gateway/.env`
- give the rest of the stack only `TRELLO_GATEWAY_URL` and `TRELLO_GATEWAY_KEY`
- `trello-bridge` loads `trello-gateway/.env` read-only via `TRELLO_PIPELINE_ENV_FILE` for the optional fallback poll only; do not put raw Trello creds in `/home/deploy/openclaw/.env`
- keep webhook secrets such as `GITHUB_PR_WEBHOOK_SECRET` in `/home/deploy/openclaw/.env`
- recreate only the affected services after rotating env values
