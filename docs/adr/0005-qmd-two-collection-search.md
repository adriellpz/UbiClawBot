# Two qmd collections for wiki and openclaw-docs search

qmd search is split into two separate collections — `wiki` (the curated personal KB, ~180 in-scope pages) and `openclaw-docs` (the OpenClaw platform documentation mirror, ~442 pages) — rather than one combined index or excluding openclaw-docs entirely.

**Why two collections:** `wiki` search drives wiki ingest, lint, and contradiction-search; those operations must not see platform docs or they generate false cross-corpus contradictions. `openclaw-docs` is genuine agent-facing reference (cli, gateway, providers, tools, concepts) that agents need to query independently. A single combined index would couple the curator's corpus health tools to unrelated platform docs; excluding openclaw-docs entirely would make 442 reference pages unsearchable.

**Why the cache must be bind-mounted:** qmd stores its SQLite index and ~2 GB of embedding models under `~/.cache/qmd` inside the gateway container, which is ephemeral. Without a host bind-mount at `/home/node/.cache/qmd`, every container recreate (triggered by CI deploys) wipes the index and models, requiring a fresh ~40-min CPU embed on the next cron run. The cache mount makes the index survive deploys.

**Embed batching:** `qmd embed --max-docs-per-batch 100` (≈140 chunks, ≈10 min per batch on the 2-core droplet) prevents model session expiry across the combined ~850-chunk corpus. Both collections receive full vector embeddings; hybrid query (`qmd query -c <collection>`) is uniform across both.

**`index.yml` ownership:** collection configuration lives at `deploy/host-config/qmd/index.yml`, tracked in the repo and deployed via `deploy/manifest.json` so a fresh droplet rebuild requires no manual steps.

**Status:** accepted
