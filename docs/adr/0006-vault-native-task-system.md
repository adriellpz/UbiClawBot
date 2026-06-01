# ADR-0006: Replace Trello with a Vault-Native Task System

## Status

Proposed (POC in progress)

## Context

Trello serves as the task state machine, calendar scheduling anchor, and event source for the production pipeline. Three compounding pain points drove this decision:

1. **External API dependency** — the `trello-gateway` is a non-trivial service to maintain; Trello webhooks drift, API keys rotate, and any Trello downtime breaks the pipeline entirely.
2. **UI friction** — the Trello board is not the operator's primary workspace; Obsidian is. Switching to Trello for task management is friction that compounds daily.
3. **Cost and lock-in** — Trello Power-Ups, workspace limits, and per-agent credential overhead add ongoing cost with no strategic benefit.

The operator uses both the board view and the calendar view equally. Agents are the primary movers on automation-owned lists (`Scheduled`, `Reschedule`, `Routine`, `Missed`); the operator owns manual-intent lists (`Adriel Focus`); some lists are mixed.

The existing `trello-gateway` HTTP interface, transition matrix, and per-agent authorization rules have proven correct — they should be preserved, not redesigned.

## Decision

Replace Trello with a vault-native task system:

- **Task files** (`tasks/` at vault root) replace Trello cards — one markdown file per task, frontmatter carries `status`, `due`, `agent`.
- **Task gateway** replaces `trello-gateway` — same HTTP interface, same transition matrix and per-agent authorization rules, backed by the filesystem instead of the Trello API. Zero agent-skill changes required.
- **Task watcher** replaces Trello webhooks — filesystem daemon on `tasks/` dispatches pipeline automation on frontmatter `status:` changes.
- **Calendar integration** is unchanged — same reschedule/missed/done logic, data source switches from Trello API to task file frontmatter.
- **Archival path** is unchanged — archived tasks move to wiki via raw-input → Cheryl, same as any other produced artifact.
- **Board UI** — evaluate the Obsidian Projects plugin and a minimal self-hosted Kanban (Node.js + vanilla HTML) during the POC before committing to either.

## Alternatives Considered

- **Replace Trello with another SaaS** (Linear, GitHub Issues) — solves lock-in but not the external API dependency or the UI friction; still requires a gateway layer.
- **Keep Trello, reduce gateway complexity** — addresses maintenance burden but not cost or UI friction; treats symptoms.
- **Agents write task files directly** — eliminates the gateway entirely, but loses centralized transition enforcement and per-agent authorization. Rejected for the same reasons `trello-gateway` existed.

## Consequences

### Positive

- No external API dependency; pipeline survives Trello outages by definition.
- Board, calendar, and agent write path all operate on the same vault files — single source of truth.
- Transition matrix and per-agent authorization carry over verbatim; agent skills unchanged.
- Filesystem watcher is more reliable than Trello webhooks (no registration drift, no external callback).

### Negative

- A new daemon (task watcher) must run on the droplet alongside the task gateway.
- Board plugin (if Obsidian-based) is a community plugin dependency — file format tied to plugin version.
- Migration requires exporting live Trello cards and seeding `tasks/` before cutover.
- No Trello mobile app; mobile access to the board requires Obsidian mobile or the self-hosted board.
