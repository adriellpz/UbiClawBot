# PRD: Task Links (ADO-style, Obsidian-native)

## Problem Statement

The vault-native task system has no way to express relationships between task files. When a task depends on another being completed first, or when a large task is decomposed into subtasks, there is no machine-readable structure to capture that — the relationship exists only in the operator's head. This makes it impossible for the board to surface blocked tasks, impossible for agents to reason about dependency order, and impossible for the operator to navigate a task hierarchy from within Obsidian.

## Solution

Add typed task links to the vault-native task system. Three link types — **blocks/blocked-by**, **parent/child**, and **related** — are stored as `[[wikilink|Title]]` alias strings in task file frontmatter. This makes links natively indexed by Obsidian's graph view and backlinks panel while remaining machine-readable by the task board server. The task board surfaces a blocked indicator on cards in the column view and a links panel in the card detail. The server enforces parent/child cascade rules and blocks writes outside `tasks/`.

## User Stories

1. As an operator, I want to mark one task as blocking another, so that I can see at a glance which tasks cannot be started yet.
2. As an operator, I want blocked tasks to show a visual indicator on the Kanban board, so that I don't accidentally start work on something that has an unresolved dependency.
3. As an operator, I want to open a card and see all of its links (blocks, blocked-by, parent, children, related) in a dedicated panel, so that I can navigate the task dependency graph from the board.
4. As an operator, I want linked task titles shown in the links panel, so that I can understand relationships without knowing filenames.
5. As an operator, I want to click a linked task in the links panel and open it directly, so that I can navigate between dependent tasks without leaving the board.
6. As an operator, I want to decompose a task into subtasks by marking a parent/child relationship, so that I can track progress on large pieces of work.
7. As an operator, I want the parent task to automatically advance to Done when all its children reach Done, so that I don't have to manually close parent tasks.
8. As an operator, I want the board to block me from moving a parent to Done while any child is still open, so that I don't accidentally close a task that has outstanding work.
9. As an operator, I want the board to block me from linking a child to a parent that is already Done, so that I don't create inconsistent state.
10. As an operator, I want related tasks to be linkable without implying any dependency or hierarchy, so that I can express loose associations for navigation purposes.
11. As an operator, I want links to be visible in Obsidian's graph view and backlinks panel, so that I can use Obsidian's native tooling to navigate the task dependency graph.
12. As an operator, I want links to survive task archival without breaking, so that I can navigate to completed tasks from their dependents.
13. As an agent, I want to create and remove task links via the gateway's `link` and `unlink` operations, so that I can express dependencies I discover during work.
14. As an agent, I want the gateway to automatically maintain the reverse side of every link, so that I only need to assert one direction and the other is always consistent.
15. As an agent, I want the gateway to reject any `link` operation that targets a file outside `tasks/`, so that links cannot silently point into the wiki or other vault directories.
16. As an operator, I want a blocked card's indicator to disappear automatically when its blocker is resolved (moved to Done or archived), so that the blocked state is always accurate without manual cleanup.
17. As an operator, I want the board's "blocked" derived state to treat tasks absent from `tasks/` as resolved, so that archived blockers don't permanently block their dependents.
18. As an operator, I want each task to have at most one parent, so that the cascade rules are unambiguous.
19. As an operator, I want all agents to have equal permission to create and remove all link types, so that any agent can express dependencies it discovers.
20. As an operator, I want link frontmatter keys to use `[[filename|Title]]` alias syntax, so that Obsidian renders human-readable titles everywhere — graph tooltips, backlinks panel, search results.

## Implementation Decisions

### Frontmatter schema

Task files gain five new optional frontmatter keys:

- `blocks` — list of `[[filename|Title]]` strings (tasks this one blocks)
- `blocked-by` — list of `[[filename|Title]]` strings (tasks blocking this one)
- `parent` — single `[[filename|Title]]` string (not a list; at most one parent)
- `children` — list of `[[filename|Title]]` strings
- `related` — list of `[[filename|Title]]` strings (symmetric, no cascade rules)

All other frontmatter keys are unchanged. Missing keys are treated as empty (no links).

### Wikilink parser

A dedicated wikilink module encapsulates reading and writing the `[[filename|Title]]` format:

- `parseWikilink(str)` → `{ filename, title }` — strips `[[` `]]`, splits on `|`
- `formatWikilink(filename, title)` → `"[[filename|Title]]"`
- `parseLinkList(fmValue)` → array of `{ filename, title }` — handles missing key (empty array), single string, YAML list
- `formatLinkList(links)` → array of `[[filename|Title]]` strings for YAML serialization

This module has no filesystem dependency and can be tested in isolation.

### Gateway link operations

Two new operations on the task board server:

**`POST /api/tasks/:filename/links`** — `{ type, targetFilename }`

- Validates `type` is one of `blocks`, `parent`, `related`
- Resolves `targetFilename` via `safeTaskPath`; rejects if outside `tasks/`
- Reads title from target file's frontmatter for the alias
- Applies link to source file and reverse link to target file atomically (both writes before either response)
- Enforces: `parent` → rejects if source already has a parent; rejects if target is `status: Done`
- Returns `{ ok: true }` or `{ error, reason }`

**`DELETE /api/tasks/:filename/links`** — `{ type, targetFilename }`

- Removes link from source file and reverse from target file atomically

Both operations use the existing `safeTaskPath` boundary check. Neither operation is in `PATCH_ALLOWED` — links are not settable via the `PATCH /api/tasks/:filename` endpoint.

### Parent/child cascade

Inside `patchTask`, after writing a `status: Done` change:

1. If the task has a `parent`, read the parent file and check whether all its `children` are now `Done` (absent from `tasks/` counts as Done). If yes, recursively apply `status: Done` to the parent.
2. Before writing `status: Done` on any task, check if the task has `children` entries present in `tasks/` that are not `Done`. If any, reject with `{ error: 'children_not_done', blocking: [...] }`.

These rules live in a pure `checkCascadeRules(filename, newStatus, taskIndex)` function testable without HTTP.

### Board: blocked derived state

`readTasks()` already returns all task files. After loading, for each task, compute:

```
isBlocked = task.blocked-by.some(link =>
  tasksIndex.has(link.filename) && tasksIndex.get(link.filename).status !== 'Done'
)
```

Tasks absent from `tasks/` (archived to wiki) are treated as resolved. `isBlocked` is added to the task object returned by `GET /api/tasks` — it is never stored in the file.

### Board UI: blocked indicator

Cards with `isBlocked: true` receive a `data-blocked` attribute. CSS renders a red left-border accent (reusing the existing `.col-Blocked .card` color token `#8c3030`) and a small pill label "blocked" in the card meta row. No new color tokens needed.

### Board UI: links panel in card detail

The existing card detail modal gains a "Links" section below the body. For each non-empty link key (`blocks`, `blocked-by`, `parent`, `children`, `related`), render a labeled group of clickable task titles. Clicking a title opens that card's detail modal. The section is hidden when the card has no links.

The detail modal already fetches the full task object via `GET /api/tasks/:filename`. No new endpoint needed — the link frontmatter keys are included in the task object returned by that endpoint.

## Testing Decisions

Good tests assert external behavior through the module's public interface — not internal data structures or private functions.

**Wikilink parser** — unit test `parseWikilink`, `formatWikilink`, `parseLinkList`, `formatLinkList`. Cover: missing key, single string, YAML list, alias with pipe, filename without alias. This module is pure (no I/O), fast, and the foundation everything else depends on.

**Cascade rules** — unit test `checkCascadeRules` with an in-memory task index. Cover: Done allowed when no children; Done blocked when one child is open; Done allowed when all children are Done; Done allowed when children are absent from index (archived); parent auto-advances when last child goes Done.

**Link operations (integration)** — test `POST /api/tasks/:filename/links` and `DELETE` against a real temp `tasks/` directory. Cover: forward and reverse links both written; `parent` rejects if target is Done; `parent` rejects if source already has a parent; target outside `tasks/` rejected with 403; unknown `type` rejected.

Prior art: the existing `task-board/server.mjs` has no test file yet. The trello-gateway tests (`trello-gateway/trello_gateway.test.mjs`) are the closest structural model — they spin up the server against fixture data and assert HTTP responses.

## Out of Scope

- Link types beyond blocks/blocked-by, parent/child, and related (e.g., duplicate, successor/predecessor)
- Per-agent authorization rules for link operations (all agents may link/unlink any type)
- A dedicated dependency graph view on the board (Obsidian's graph view covers this)
- Bulk link operations (create multiple links in one request)
- Link validation on task file edits made directly in Obsidian (the gateway is the enforcing writer; direct-edit consistency is out of scope)
- Status cascade from parent to children (only children→parent cascade is in scope)

## Further Notes

The `[[filename|Title]]` wikilink format is indexed by Obsidian's Properties system (v1.4+) — it appears in the graph view and backlinks panel vault-wide. Since task files are never deleted (only archived to wiki), wikilinks never become broken even after a task is archived. The board treats a `blocked-by` link pointing to a file absent from `tasks/` as resolved rather than broken.

ADR-0007 (`docs/adr/0007-task-link-format.md`) records the decision to use frontmatter wikilinks over plain strings or a `## Links` body section.
