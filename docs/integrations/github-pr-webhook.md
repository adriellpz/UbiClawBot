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

- `TRELLO_INTAKE_LIST_ID`
- `TRELLO_DONE_LIST_NAMES`
- `OPENCLAW_HOOK_URL`
- `OPENCLAW_HOOK_TOKEN`
- `OPENCLAW_HOOK_AGENT_ID` (defaults to `marcos` — Marcos owns GitHub PR review)

## Behavior

- creates or updates **PR review cards** in the configured intake list (typically **Backlog**)
- wakes **Marcos** (`OPENCLAW_HOOK_AGENT_ID`) to leave the GitHub review and update the Trello card
- `trello-pipeline` skips Ubi backlog intake when it detects a PR review card title (`Review PR #N`)
- ignores unsupported webhook action types
- treats Trello search results as candidates only, then exact-matches the PR number or PR URL before updating an existing card
- ignores historical cards in configured done lists during dedupe
