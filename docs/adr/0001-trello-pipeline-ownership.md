# ADR-0001: UbiClawBot Owns The Trello Production Pipeline

This ADR is historical context. For the active current-state summary, use `docs/architecture/README.md`.

## Status

Accepted

## Context

The current production Trello/calendar automation is split across two repositories:

- `UbiClawBot` already owns some canonical deploy artifacts, especially the Trello gateway.
- `UbiAgent` still contains production-used Trello automation source, including scheduled routine jobs and the webhook-driven queue/handler flow.

This split makes ownership unclear because source, deploy, runtime paths, and service state do not line up. It also encourages temporary fixes to land in the agent workspace even when the code is part of the unattended production Trello/calendar system.

## Decision

`UbiClawBot` is the canonical owner of the **Trello production pipeline** and related **scheduled Trello/calendar jobs**.

This includes:

- the Trello webhook pipeline
- unattended queue/worker logic
- deterministic Trello/calendar handlers
- scheduled Trello/calendar jobs such as routines
- the durable operational state required by that pipeline

`UbiAgent` remains the **agent workspace**. It continues to own agent memory, hooks, persona/taskflow material, experiments, manual helpers, and other workspace-specific runtime concerns.

Production should run Trello pipeline code from **repo-owned runtime paths** associated with `UbiClawBot`, not from workspace-mounted `UbiAgent` paths.

## Consequences

### Positive

- One canonical owner for Trello production code, runtime paths, and pipeline state.
- Cleaner separation between product/infrastructure code and agent workspace concerns.
- Lower risk of “fixed the wrong copy” problems during production changes.
- Easier TDD and deploy validation inside the repo that owns the production pipeline.

### Negative

- `UbiClawBot` expands from a narrower deploy/config role into a broader production-pipeline repo.
- Migration requires coordinated changes to source layout, runtime paths, state paths, and docs.
- There is short-term duplication risk while slices are being moved out of `UbiAgent`.

## Migration Guidance

- Migrate by vertical slice, not by isolated file.
- Start with the routines slice.
- Treat the existing `UbiAgent` routines-fix branch as a spike/reference, not the final merge target.
- After routines are stable in `UbiClawBot`, migrate the webhook pipeline as a second coherent step.
