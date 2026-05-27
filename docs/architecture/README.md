# Architecture

## Ownership boundary

`UbiClawBot` owns:

- deploy/config glue around OpenClaw
- the production Trello webhook pipeline
- the isolated Trello gateway
- the GitHub PR intake bridge
- the scheduled Trello/calendar routines runtime

The agent repos (`UbiAgent`, `MarcosAgent`, and `CherylAgent`) own workspace-specific process docs, persona/state material, skills, and local operating guidance. They are not the source of truth for the production Trello runtime.

## Historical context

The ownership decision is recorded in [`../adr/0001-trello-pipeline-ownership.md`](../adr/0001-trello-pipeline-ownership.md). Treat that ADR as history; use the pages in this `docs/` tree for current operational guidance.
