# Architecture

This page describes the current ownership and runtime boundaries. It is the active architecture summary; the ADRs remain the historical decision record.

## Ownership Boundary

- `UbiClawBot` owns the Trello production pipeline, its service contracts, and the deployment/config glue around the pinned OpenClaw runtime.
- `UbiAgent` is the agent workspace. It owns workspace-specific memory, hooks, persona material, experiments, and manual helpers.
- Trello production pipeline state is part of the pipeline domain, not agent workspace state.

## Runtime Shape

- OpenClaw itself runs from a pinned container image rather than vendored source in this repo.
- `trello-gateway` holds the raw Trello credentials.
- `trello-pipeline` owns webhook ingress, queueing, and deterministic handlers.
- `trello-routines` owns unattended scheduled Trello/calendar materialization.
- `github-pr-bridge` is a separate ingress for GitHub PR review intake.

## Documentation Boundary

- Active operational docs live under `docs/`.
- `CONTEXT.md` stays at the repo root as the glossary.
- `AGENTS.md` stays at the repo root as thin agent-facing guidance.
- ADRs remain in `docs/adr/` as historical records.

For the historical ownership decision, see [ADR-0001](../adr/0001-trello-pipeline-ownership.md). For project vocabulary, see [`CONTEXT.md`](../../CONTEXT.md).
