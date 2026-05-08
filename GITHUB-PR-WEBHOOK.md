# GitHub PR Webhook Intake (Ubi/OpenClaw)

This deployment adds a `github-pr-bridge` sidecar that receives GitHub `pull_request` webhooks, verifies HMAC signatures, and creates/updates Trello review cards for Ubi.

## Webhook endpoint

- URL: `https://ai.sonofwolf.org/github-pr`
- Content type: `application/json`
- Secret: must match `GITHUB_PR_WEBHOOK_SECRET` in droplet `.env`
- SSL verification: enabled

## GitHub webhook settings

In `adriellpz/UbiClawBot`:

1. Settings -> Webhooks -> Add webhook
2. Payload URL: `https://ai.sonofwolf.org/github-pr`
3. Content type: `application/json`
4. Secret: set to a strong shared secret (same as droplet env var)
5. Events: **Let me select individual events** -> check only `Pull requests`
6. Active: enabled

## Required secrets/env on droplet

Set these in `/home/deploy/openclaw/.env` (server-side only):

- `GITHUB_PR_WEBHOOK_SECRET` (required)
- `TRELLO_API_KEY` (required)
- `TRELLO_API_TOKEN` (required)
- `TRELLO_BOARD_ID` (recommended, example `sKapJDvB`)
- `TRELLO_INTAKE_LIST_ID` (optional but recommended; if missing, first open list on the board is used)
- `GITHUB_PR_BRIDGE_PORT` (optional, default `19091`)

No secret values are committed in git.

## Handled events/actions

Only `pull_request` webhook events are accepted.

Actions processed:

- `opened`
- `reopened`
- `synchronize`
- `ready_for_review`
- `review_requested`

Other actions are acknowledged and ignored.

## Trello behavior

- Creates card title as `P2 - Review PR <number>` by default
- Escalates to `P1 - Review PR <number>` for `review_requested` or urgent/P1 labels
- Card description includes PR URL/title/action/branches/author and review gate reminder
- Dedupe: if an open card already references `/pull/<number>`, the bridge adds a comment update instead of creating a duplicate
- Does not move cards into/out of any specific list beyond initial intake placement

## Manual test / redelivery

1. Open a test PR (or sync by pushing to PR branch).
2. In GitHub webhook delivery history, confirm `2xx` response from `https://ai.sonofwolf.org/github-pr`.
3. In Trello, confirm either:
   - a new `P2 - Review PR <number>` (or `P1`) card, or
   - a comment on the existing PR card (dedupe path).

You can also use GitHub webhook "Redeliver" on a recent event after changes.

## Required GitHub permission to configure webhook

Creating/editing repo webhooks requires repository admin webhook access (`admin:repo_hook` for classic PAT, or equivalent repository "Webhooks: Read and write" permission). Ubi review tokens without webhook-admin scope cannot create webhooks.
