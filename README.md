# UbiClawBot

Canonical repo for the Trello production pipeline and the deployment/config glue around the pinned OpenClaw runtime.

Start with [Docs](./docs/README.md).

Root docs that intentionally stay outside `docs/`:

- [CONTEXT.md](./CONTEXT.md): glossary
- [AGENTS.md](./AGENTS.md): thin agent-facing guidance

## Validation

Run the local static gate before changing deploy contracts or docs that describe them:

```bash
npm ci --include=dev
npm test
```

