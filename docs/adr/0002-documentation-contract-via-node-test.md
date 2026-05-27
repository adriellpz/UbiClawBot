---
status: accepted
---

# Documentation contract checks via node:test (not test-gate monolith)

We will move structural documentation invariants out of the standalone `scripts/test-gate.mjs` script into `node:test` cases (for example `docs-contract.test.mjs`) under `UbiClawBot`, including cross-repo assertions against sibling agent repositories. `npm test` will run only `node --test` targets; the monolithic gate script will be removed once all invariants are migrated.

Ralph implement phases use test-driven development: one `node:test` per RED→GREEN→REFACTOR cycle, two tests per implement phase, with the full ordered queue authored by review. This keeps verification aligned with the TDD skill and avoids duplicate rule definitions between a gate script and tests.
