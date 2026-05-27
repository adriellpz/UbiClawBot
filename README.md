# UbiClawBot

Private deploy/config repository for OpenClaw plus the repo-owned Trello production services.

Current active docs live in [`docs/README.md`](./docs/README.md).

- [`CONTEXT.md`](./CONTEXT.md) keeps the project glossary.
- [`AGENTS.md`](./AGENTS.md) stays as thin agent-facing guidance.

Run the static gate before deploy/config changes:

```bash
npm ci --include=dev
npm test
```

