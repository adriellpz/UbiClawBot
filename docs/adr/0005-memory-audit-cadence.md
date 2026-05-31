# Memory audit cadence

We split memory hygiene from the Reddit OpenClaw 101 "all-in-heartbeat" model: **session memory rules** live in each agent's `HEARTBEAT.md`; **scheduled memory audit** runs as six isolated cron jobs (Ubi, Cheryl, Marcos × weekly + monthly) invoking per-agent **memory audit skills** in the vault. Agents audit only their own **session notes** and **agent quick-reference** (`MEMORY.md`), **memory promote** cross-agent facts via **raw input**, and do not edit **wiki/** (Cheryl's **wiki maintainer** domain).

**Considered options:** (1) Reddit-style all-in-heartbeat with daily/weekly checks in `HEARTBEAT.md`; (2) Ubi-only audit; (3) shared wiki runbook instead of per-agent skills; (4) Supermemory off-instance backup. We chose isolated crons + three skills + heartbeat session rules only, all three agents, rule-based retention, and vault sync as backup (no Supermemory).

**Consequences:**

- `memorySearch.experimental.sessionMemory` enabled agent-wide in `openclaw.json`
- **Wiki curator** rescheduled from `*/15` to six times daily (midnight, 9 AM, noon, 3 PM, 6 PM, 9 PM America/Denver)
- Memory audit times (MT): Ubi 1:00, Marcos 3:15, Cheryl 5:15 — weekly Mondays; monthly 1st; weekly no-ops on 1st when monthly replaces it
- Weekly audit: Telegram only on **drift**; monthly: always brief Telegram per agent
- Glossary terms in `CONTEXT.md`; procedure in vault skills (`*-memory-audit`)

**Status:** accepted
