# Secrets

Real secrets stay on the droplet. Git keeps placeholders and safe templates only.

## Host-Only Secret Surface

- `/home/deploy/openclaw/.env`: runtime env for the OpenClaw stack and sidecars.
- `/home/deploy/openclaw/trello-gateway/.env`: raw Trello credentials plus `GATEWAY_KEY`.
- Runtime OpenClaw config file: the live `openclaw.json` under the host config directory mounted by Compose.

The tracked templates are secondary reference material:

- `.env.example`
- `trello-gateway/.env.example`
- `config/openclaw.example.json`

If the live host files differ from the templates, the live host files win.

## Rotation Rules

- Never commit real secret values.
- Edit host-only files in place on the droplet.
- Recreate only the services that need the new env/config after a secret change.
- Keep `TRELLO_GATEWAY_KEY` aligned between `/home/deploy/openclaw/.env` and `/home/deploy/openclaw/trello-gateway/.env`.

## Common Secret Groups

- Gateway auth: `OPENCLAW_GATEWAY_TOKEN`
- Trello gateway access: `TRELLO_GATEWAY_URL`, `TRELLO_GATEWAY_KEY`
- GitHub CLI/git auth inside the gateway container: `GITHUB_TOKEN` or `GH_TOKEN`
- GitHub PR webhook intake: `GITHUB_PR_WEBHOOK_SECRET`
- OpenClaw wake hook for GitHub PR intake: `OPENCLAW_HOOK_URL`, `OPENCLAW_HOOK_TOKEN`
- Google Calendar / `gog` auth material in the mounted config home

## Example Rotation Flow

1. Edit `/home/deploy/openclaw/.env` or `/home/deploy/openclaw/trello-gateway/.env`.
2. Recreate the affected services with `docker compose up -d --force-recreate ...`.
3. Confirm the service came back healthy.

For the webhook-specific env contract, see [GitHub PR Webhook](../integrations/github-pr-webhook.md).
