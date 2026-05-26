# Docs

This is the canonical home for active `UbiClawBot` documentation.

`UbiClawBot` owns the Trello production pipeline, its service contracts, and the deployment/config glue around the pinned OpenClaw runtime. The repo root stays intentionally small:

- `README.md` is the entrypoint.
- `CONTEXT.md` is the glossary.
- `AGENTS.md` is thin agent-facing guidance.

## Topics

- [Deployment](./deployment/README.md): current deploy model, tracked artifacts, and update flow.
- [Secrets](./deployment/secrets.md): host-only secret files and rotation rules.
- [Services](./services/trello-gateway.md): Trello gateway contract.
- [Services](./services/trello-pipeline.md): webhook ingress and queue worker contract.
- [Services](./services/trello-routines.md): unattended routines contract.
- [Integrations](./integrations/github-pr-webhook.md): GitHub PR webhook intake.
- [Architecture](./architecture/README.md): current ownership boundaries and runtime shape.
- [ADR-0001](./adr/0001-trello-pipeline-ownership.md): historical decision record for pipeline ownership.

## Verification Rule

When docs and examples disagree, use this order of trust:

1. Live deployment/runtime state.
2. Current repo wiring such as `.github/workflows/deploy-droplet.yml` and `workspace/docker-compose.droplet.yml`.
3. Examples and templates such as `.env.example` and `config/openclaw.example.json`.
