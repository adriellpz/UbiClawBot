# GitHub PR Webhook

`github-pr-bridge` receives GitHub `pull_request` webhooks, verifies the signature, and creates or updates Trello review cards.

## Endpoint

- URL: `https://ai.sonofwolf.org/github-pr`
- Content type: `application/json`
- Secret: must match `GITHUB_PR_WEBHOOK_SECRET` in `/home/deploy/openclaw/.env`

## Required Host Env

- `GITHUB_PR_WEBHOOK_SECRET`
- `TRELLO_GATEWAY_URL`
- `TRELLO_GATEWAY_KEY`
- `TRELLO_GATEWAY_AGENT_ID` (optional, defaults to `main`)
- `TRELLO_BOARD_ID`
- `TRELLO_INTAKE_LIST_ID` (recommended)
- `TRELLO_DONE_LIST_NAMES` (optional, defaults to `Done`)
- `OPENCLAW_HOOK_URL` and `OPENCLAW_HOOK_TOKEN` for immediate wake-up

## Handled Actions

The bridge accepts `pull_request` events and processes these actions:

- `opened`
- `reopened`
- `synchronize`
- `ready_for_review`
- `review_requested`

Other actions are acknowledged and ignored.

## Behavior

- Trello writes go through `trello-gateway`, not raw tokens in the bridge container.
- Dedupe is based on exact PR identity, not loose Trello search results alone.
- Historical cards in done/archive state are ignored during dedupe.
- After create or update, the bridge can send a sanitized wake event to OpenClaw using a deterministic session key.

## Configure In GitHub

1. Go to the repository webhook settings.
2. Add `https://ai.sonofwolf.org/github-pr`.
3. Use `application/json`.
4. Set the shared secret to the same value as `GITHUB_PR_WEBHOOK_SECRET`.
5. Subscribe only to `Pull requests`.

For host-side secret handling, see [Secrets](../deployment/secrets.md).
