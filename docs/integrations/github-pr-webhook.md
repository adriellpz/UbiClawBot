# GitHub PR Webhook

`github-pr-bridge` receives GitHub `pull_request` webhooks, verifies `X-Hub-Signature-256`, creates or updates Trello review cards through `trello-gateway`, and can wake OpenClaw after the Trello write succeeds.

## Endpoint

- URL: `https://ai.sonofwolf.org/github-pr`
- event family: `pull_request`
- content type: `application/json`
- secret source: `GITHUB_PR_WEBHOOK_SECRET` in `/home/deploy/openclaw/.env`

## Required runtime env

- `GITHUB_PR_WEBHOOK_SECRET`
- `TRELLO_GATEWAY_URL`
- `TRELLO_GATEWAY_KEY`
- `TRELLO_BOARD_ID`

Optional but normally useful:

- `TRELLO_GATEWAY_AGENT_ID` (defaults to `system` — hook bridge card/comment authorship as systemworker)
- `TRELLO_INTAKE_LIST_ID`
- `TRELLO_DONE_LIST_NAMES`
- `OPENCLAW_HOOK_URL`
- `OPENCLAW_HOOK_TOKEN`
- `OPENCLAW_HOOK_AGENT_ID` (defaults to `marcos` — Marcos owns GitHub PR review; do not set to `main` on the droplet)

## Behavior

- creates or updates **PR review cards** in the configured intake list (typically **Backlog**) as **systemworker** (`TRELLO_GATEWAY_AGENT_ID`)
- wakes **Marcos** (`OPENCLAW_HOOK_AGENT_ID`) to leave the GitHub review and update the Trello card
- `trello-pipeline` skips Ubi backlog intake when it detects a PR review card title (`Review PR #N`)
- ignores unsupported webhook action types
- treats Trello search results as candidates only, then exact-matches the PR number or PR URL before updating an existing card
- reuses the canonical card for a PR when a matching card is already in **Done** (avoids duplicate cards on webhook re-delivery)
- when multiple open cards match the same PR, updates the canonical card and comments on duplicates pointing at it
- remembers recently created cards for a short TTL so sequential webhook deliveries are not duplicated when Trello search has not indexed the new card yet
- `TRELLO_DONE_LIST_NAMES` still marks Done-list cards as lower priority than active review cards during dedupe
