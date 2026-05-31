# Wiki maintainer — HITL operator checklists

Human-in-the-loop slices for the LLM Wiki maintainer program (Cheryl v2). AFK contract tests are complete (`npm test` 145/145); these slices require operator action on the live droplet before the program can close.

**Status:** `hitl_blocked` until each section is signed off.  
**Parent issues:** `planning/prd/llm-wiki-maintainer/llm-wiki-maintainer-issues.md` (LLM-WM-09, WM-11, WM-13)  
**Frozen program PRD:** Ralph loop `prd.md` — `authorizeShip` remains **false**.

| Slice | Type | Contract coverage | This doc |
|-------|------|-------------------|----------|
| **WM-09** | HITL | Test 25 — `reindexWikiSearch` skips when qmd absent | § WM-09 |
| **WM-11** | HITL | Test 26 — CLAIM contradiction in full lint | § WM-11 |
| **WM-13** | HITL | WM-08 tick + WM-06 hook (test 29) | § WM-13 |
| **WM-05/06/07** | AFK partial | Tests 13–18, 27–29 | § E2E waivers |

**Droplet context:** artifact tree `/home/deploy/openclaw`, vault `/home/node/.openclaw/agent-vault` (host: `/home/deploy/openclaw/data/agent-vault`), Cheryl wiki maintainer runtime `/home/node/.openclaw/agent-runtime/cheryl/wiki-maintainer/` (host: `/home/deploy/openclaw/data/agent-runtime/cheryl/wiki-maintainer/`). Deployed via `deploy/manifest.json` bundle `cheryl-wiki-maintainer` — no manual rsync. See [`README.md`](./README.md), [`openclaw-agents.md`](./openclaw-agents.md), [`live-verification.md`](./live-verification.md).

---

## WM-09 — Wiki search with qmd

**Slice status:** `hitl_blocked`  
**Blocked by:** operator install + first-query verification (code skips gracefully until then)

### Operator prerequisites

- SSH access to production droplet as deploy/root per [`live-verification.md`](./live-verification.md)
- Disk headroom for **~2GB** qmd model download on first use
- `qmd` binary on `PATH` inside the **openclaw-gateway** container (or host path mounted into exec context Cheryl uses)
- Vault layout bootstrapped (`wiki/` buckets, `wiki/workflows/wiki-curator.md`)
- Wiki maintainer `lib/` + `bin/` deployed to Cheryl **agent runtime** on each `main` deploy (see `deploy/manifest.json` → `cheryl-wiki-maintainer`)

### Install qmd on droplet

1. Install qmd per upstream docs on the droplet (or bake into gateway image). Confirm version:

   ```bash
   qmd --version
   ```

2. On **first collection add or query**, allow model download (~2GB). Monitor disk and completion.

3. Configure an in-scope **wiki** collection only — same exclusions as **wiki log** registry:

   - Include: integrated pages under `wiki/` (reports, runbooks, workflows, job-search, personal, projects, contradictions, etc.)
   - Exclude: `wiki/openclaw-docs/**`, `**/*-index.md`, `wiki/log.md`, `wiki/index.md`
   - Exclude from index: `wiki/sources/**`, `raw-input/**` (not integrated wiki until ingested)

4. Document invocation in Ubi **AGENTS.md** (read path + example `qmd query`) once smoke passes.

### Verification steps

| # | Check | Pass criteria |
|---|--------|----------------|
| 1 | Binary | `qmd --version` exits 0 on host/container used by maintainer |
| 2 | Collection | Wiki collection exists; excluded paths not indexed |
| 3 | Reindex hook | After a maintainer tick that touches `wiki/`, `reindexWikiSearch` returns `{ ok: true }` (not `skipped: true`) — see `wiki-search-index-manager.mjs` |
| 4 | Query smoke | Ingest or edit a known page → `qmd query "<unique phrase from page>"` returns that page |
| 5 | Cron | Cheryl wiki maintainer job (six times daily, America/Denver) still runs; tick logs show reindex when qmd present |

**Contract reference:** `reindexWikiSearch skips gracefully when qmd absent` (test 25) — until install, ticks continue with `reason: qmd not installed (WM-09 HITL)`.

### Sign-off

- [ ] qmd installed; first-run models downloaded  
- [ ] In-scope wiki collection configured  
- [ ] Post-ingest `qmd query` returns expected page  
- [ ] Ubi AGENTS.md documents search usage  

**Operator / date:** _______________

---

## WM-11 — Daily contradiction review (Telegram)

**Slice status:** `hitl_blocked`  
**Blocked by:** operator-approved schedule + live Telegram smoke  
**Depends on:** WM-09 recommended for full contradiction search; WM-10 CLAIM detection contract-tested (test 26)

### Operator prerequisites

- WM-10 behavior understood: **full wiki lint** on curator idle **tick 4** creates `wiki/contradictions/<slug>.md` and inline `> **Contradiction:**` callouts
- Open contradiction record available for smoke (or seed from test fixture on staging vault)
- Telegram delivery channel configured for Cheryl (`scheduler`) per live OpenClaw config
- Authority to edit live cron: `/root/openclaw/data/config/cron/jobs.json` (see [`openclaw-agents.md`](./openclaw-agents.md))

### Register daily contradiction-review cron

1. Add a **separate** daily job (not the wiki maintainer curator tick):

   - **Agent:** `scheduler` (Cheryl)
   - **Schedule:** operator-chosen local time — default **`0 8 * * *`** `America/Denver` (08:00 MT daily)
   - **Payload:** list open records under `wiki/contradictions/`; summarize findings; deliver via Telegram when count > 0; otherwise **NO_REPLY**
   - **Resolution flow (conversational):** operator directs Cheryl to update affected pages, remove inline callouts, delete contradiction record, append **wiki log** chronicle (`lint | contradiction resolved`)

2. Mirror behavior in `wiki/workflows/wiki-curator.md` (contradiction review section) if not already present.

3. Deploy config via normal path: edit `UbiClawBot/config/live/cron/jobs.json` → merge `main` → deploy (do not hand-edit artifact tree without syncing git).

### Verification steps

| # | Check | Pass criteria |
|---|--------|----------------|
| 1 | Cron registered | Daily job visible in live `jobs.json` with approved timezone |
| 2 | Non-empty | With ≥1 open contradiction record → Telegram lists records + findings |
| 3 | Empty | With zero open records → **NO_REPLY** (no spam) |
| 4 | Resolution | After operator resolution: callouts removed, record deleted, chronicle line appended |
| 5 | Schema | `wiki-curator.md` documents daily review + Telegram-only delivery for this job |

### Sign-off

- [ ] Daily cron time confirmed (America/Denver: __________)  
- [ ] Telegram delivery verified with open record  
- [ ] **NO_REPLY** verified when no open records  
- [ ] Resolution path exercised once end-to-end  

**Operator / date:** _______________

---

## WM-13 — End-to-end droplet smoke

**Slice status:** `hitl_blocked`  
**Blocked by:** operator-run smoke on live droplet (WM-09 qmd strongly recommended)

### Operator prerequisites

- WM-09 signed off (qmd query in smoke path)
- Cheryl wiki maintainer cron enabled (`0 0,9,12,15,18,21 * * *`, America/Denver) — see `config/live/cron/jobs.json` job **Cheryl wiki maintainer**
- `cheryl-vault-inbox` skill + `wiki/workflows/wiki-curator.md` deployed to vault
- Preflight CLI: `node …/bin/wiki-log-preflight.mjs <vault-root>`
- Register CLI (after edits): `node …/bin/wiki-log-register.mjs <vault-root> wiki/path1.md …`
- Obsidian or SSH access to inspect vault files

### Smoke runbook (clip → cron → wiki + log + indexes + qmd + idle)

**Prep**

1. Note starting state: `wiki/log.md` completion registry line count, `wiki/sources/ingested.log` lines, `raw-input/` file count, `wikiMaintainer.curatorIdleStreak` in scheduler config (`openclaw.json` or `wiki-maintainer.json`).

2. **Raw input drop:** place `{agent}-YYYY-MM-DD-smoke-raw.md` in `raw-input/` (simple note, no `update:`). Wait for the **next wiki maintainer cron** (six times daily) or trigger cron manually if your ops process allows.

3. **Source clip:** place `wiki/sources/smoke-clip-YYYY-MM-DD.md` with at least one remote image URL. Wait **≥1** tick for one-source ingest (test 29 path: stub summary under `wiki/reports/`).

4. Allow **additional ticks** for maintenance backlog (up to five pages/tick) if registry incomplete.

**Observe each tick cycle**

| # | Observation | Pass criteria |
|---|-------------|----------------|
| A | Raw input | Drop removed or filed; new/updated `wiki/**` page with page format contract (frontmatter, title, blurb, `## Related`) |
| B | Source | `wiki/sources/ingested.log` contains clip path; assets under `wiki/sources/assets/<slug>/`; summary page exists; source `.md` unchanged |
| C | Log | Completion registry lines for touched pages; chronicle entry when work ran |
| D | Indexes | Touched `{folder}-index.md` and `wiki/index.md` updated |
| E | qmd | `qmd query` hits a phrase from a page touched in this smoke |
| F | Idle | When registry complete + empty `raw-input/` + all sources ingested: ticks 1–3 return **NO_REPLY**; tick 4 runs full lint (may create contradiction artifacts if corpus has conflicts) |

**Failure handling**

- Stuck drops → `raw-input/_failed/` per publishing schema
- Preflight removed registry lines after operator edit → expected; re-run maintenance
- qmd skip → complete WM-09 before claiming WM-13 done

### Sign-off

- [ ] Raw input ingest observed on droplet  
- [ ] Source clip → wiki + `ingested.log` + assets  
- [ ] Registry + chronicle + indexes updated  
- [ ] qmd query hit after change  
- [ ] **NO_REPLY** on idle ticks 1–3 when queues clear  
- [ ] `cd UbiClawBot && npm test` still 145 pass on branch used for deploy  

**Operator / date:** _______________

---

## E2E waivers (AFK slices with contract coverage)

These acceptance criteria remain **open for live droplet smoke** but are **waived for program close** because behavior is covered by contract tests and deferred to WM-13 HITL or intentional stubs.

| Slice | Contract coverage | Waived E2E gap | Rationale |
|-------|-------------------|----------------|-----------|
| **WM-05** | Tests 13–14 (`listRawInputDrops`, cheryl-vault-inbox skill/cron schema) | Raw-input ingest tick smoke (drop → formatted wiki + log + indexes in one cron cycle) | `defaultRawInputIngest` in `curator-cron-tick.mjs` lists drops only; full Cheryl LLM ingest is agent-turn behavior, not unit-tested. Live path deferred to **WM-13** HITL. |
| **WM-06** | Test 29 (`ingestOnePendingSource` per tick: assets, stub summary, `ingested.log`) | LLM multi-page synthesis + full clip→wiki integration smoke | Stub summary at `wiki/reports/{slug}.md` contract-tested; schema calls for entity/concept updates via LLM — operator verifies on droplet in **WM-13**. |
| **WM-07** | Tests 15–18 (`listMaintenanceBacklog`, `assessIdleConditions`), test 27 (`runLightWikiLint`) | Maintenance normalization tick (five pages envelope + light lint per cron) | `defaultMaintenance` returns backlog only (`didWork: false`); backlog ordering and light lint modules contract-tested. Normalization E2E deferred to **WM-13**. |

**Reviewer note:** Do not fail program `implemented` solely for WM-05/06/07 E2E gaps when this waiver table is present and WM-13 checklist is documented. WM-13 sign-off still required for droplet truth.

---

## Program close checklist (orchestrator)

1. All three HITL sections signed off (WM-09, WM-11, WM-13)  
2. E2E waiver table acknowledged in program review slice audit  
3. Two consecutive program review verdicts **`implemented`** per frozen `prd.md`  
4. `authorizeShip` stays **false** unless operator explicitly opts in later  
