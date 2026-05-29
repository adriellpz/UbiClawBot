# Raw input inbox (`raw-input/`)

Flat vault inbox sibling to `wiki/` and agent workspaces. **Producers** (Ubi, Cheryl, Marcos) drop **produced artifacts** here only—they do not edit `wiki/` in place.

## Filename convention (v1)

`{agent}-{YYYY-MM-DD}-{slug}.md`

- **agent:** `ubi`, `cheryl`, or `marcos`
- **date:** ISO date in the filename
- **slug:** short content hint (Cheryl chooses the final `wiki/` path from body + rules, not from slug bucket)

## Filing buckets (wiki top-level)

After curation, documents live under one of:

- `wiki/reports/` — dailies in `YYYY-MM-DD/` subfolders; one-offs in topic dirs (e.g. `repo-maintenance/`)
- `wiki/runbooks/` — stable practices, checklists, agent rulebooks
- `wiki/job-search/` — applications, résumés, follow-ups
- `wiki/personal/` — personal admin
- `wiki/projects/` — project writeups
- `wiki/workflows/` — cross-agent operational maps (this doc, cron summaries, helper registry)

## Curator behavior (Cheryl)

- Scan all files directly under `raw-input/`; **skip** `raw-input/_failed/`
- **Move** (`mv`) each processed drop to its target under `wiki/`; merge content only when the drop explicitly updates an existing page
- Never delete human-edited wiki pages without a matching drop that says to replace/merge
- On ambiguity or policy conflict: leave the file in `raw-input/` or move to `raw-input/_failed/` with a one-line reason file or header note
- **Reclaiming `_failed/`:** operator fixes the drop (path hint, content, or policy) and moves it back to `raw-input/` root for the next curator run; curator does not auto-retry `_failed/` without that move
- Operator may edit `wiki/` directly in Obsidian; respect those edits on merge

## Producer rules

- **Read** from `wiki/`; **write** new/changed artifacts to `raw-input/` only
- `openclaw-docs/` and `raw-input/` are excluded from operator RAG (synced for visibility only)

## Related

- Skill: `cheryl/skills/cheryl-vault-inbox/SKILL.md`
- ADR: UbiClawBot `docs/adr/0003-raw-input-wiki-curator.md`
