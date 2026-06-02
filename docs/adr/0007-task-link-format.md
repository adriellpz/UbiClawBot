# ADR-0007: Task Links as Frontmatter Wikilinks with Gateway-Maintained Bidirectionality

Task files need typed relationships (blocks/blocked-by, parent/child, related) that are both machine-readable by the task gateway and natively indexed by Obsidian's graph view and backlinks panel.

Links are stored as `[[filename|Title]]` wikilink strings in frontmatter keys (`blocks`, `blocked-by`, `parent`, `children`, `related`). Obsidian resolves wikilinks vault-wide and indexes them regardless of which folder the file lives in, so links survive task archival without becoming broken. The task gateway is the sole writer and maintains both sides of every link atomically on `link`/`unlink` operations — stripping and re-adding `[[` `]]` delimiters when reading and writing.

## Considered Options

- **Plain strings in frontmatter** (`"filename.md"`) — machine-readable but Obsidian does not index them; graph view and backlinks panel would be blind to task relationships.
- **Frontmatter + a `## Links` body section** — Obsidian-visible and human-readable, but two places to keep in sync on every link mutation.
- **Wikilinks in frontmatter** (chosen) — single source of truth; Obsidian indexes them natively via the Properties system; gateway parser handles the `[[…]]` wrapping.
