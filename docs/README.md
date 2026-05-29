# UbiClawBot Docs

`UbiClawBot` is the canonical home for the production Trello pipeline, Trello gateway, GitHub PR intake bridge, and scheduled Trello/calendar routines.

Start here:

- [`inventory.md`](./inventory.md) for documentation classification across the four in-scope repos (issue #26)
- [`deployment/README.md`](./deployment/README.md) for the current deploy model
- [`deployment/live-verification.md`](./deployment/live-verification.md) for droplet spot-check status (done / waived / blocked)
- [`deployment/secrets.md`](./deployment/secrets.md) for Actions and droplet secret contracts
- [`deployment/openclaw-agents.md`](./deployment/openclaw-agents.md) for live agent models and config paths (Cheryl = DeepSeek Flash)
- [`services/trello-gateway.md`](./services/trello-gateway.md) for the isolated Trello API service
- [`services/trello-pipeline.md`](./services/trello-pipeline.md) for webhook ingress, queue worker, and deterministic handlers
- [`services/trello-routines.md`](./services/trello-routines.md) for the scheduled routines job
- [`integrations/github-pr-webhook.md`](./integrations/github-pr-webhook.md) for PR review intake
- [`architecture/README.md`](./architecture/README.md) for ownership boundaries and historical links

Rules for the active docs set:

- current-state docs live here, not in service-local `README.md` files
- `CONTEXT.md` stays at repo root as the glossary
- `AGENTS.md` stays thin and should not become a second architecture manual
- sibling agent repos may keep workspace-only process docs, but they are not the source of truth for the production Trello runtime
