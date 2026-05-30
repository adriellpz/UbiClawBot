# LLM Wiki maintainer (Cheryl v2)

We evolve Cheryl from **wiki curator** (filing clerk — move/merge drops into bucket paths) to **wiki maintainer** (LLM Wiki pattern — compound knowledge with cross-links, synthesis, and ongoing maintenance). The vault gains a three-layer corpus: immutable **`wiki/sources/`** (operator clips + ingest-time **source assets**), curated **`wiki/`** (Cheryl-owned Obsidian corpus; operator may edit directly), and split schema docs (**wiki publishing schema**, **wiki curator schema**).

**Considered options:** (1) keep filing-clerk move/merge only; (2) defer **wiki/sources/** and qmd to v2; (3) full maintainer with combined **wiki log**, local **wiki search**, and contradiction workflow. We chose (3) for compounding knowledge while preserving ADR 0003’s inbox split — producers still publish to **raw input** only.

**Consequences:**

- **Wiki log** at `wiki/log.md` combines completion registry + chronicle (replaces simple “filed” tracking)
- **`wiki/sources/ingested.log`** tracks ingested clips; pending sources drive cron backlog
- **qmd** indexes in-scope **wiki** only; **`wiki/sources/`** and **`raw-input/`** excluded until integrated
- **Contradiction records** under `wiki/contradictions/` during **full wiki lint**; daily **contradiction review** cron (Telegram)
- ADR **0003-raw-input-wiki-curator** remains valid for inbox split and producer write boundaries

**Supersedes:** filing-clerk move semantics in Phase 2 curator PRD; legacy `wiki/workflows/raw-input.md` maintainer behavior (pointer retained for filename conventions).

**Status:** accepted (WM-01 scaffold)
