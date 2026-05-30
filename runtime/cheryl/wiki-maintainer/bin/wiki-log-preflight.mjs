#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { invalidateStaleLogEntries } from "../lib/wiki-log-preflight.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const vaultRoot = process.argv[2] ?? process.env.OPENCLAW_AGENT_VAULT_DIR;
if (!vaultRoot) {
  console.error("usage: wiki-log-preflight.mjs <vault-root> [log-path]");
  process.exit(1);
}
const logPath = process.argv[3] ?? path.join(vaultRoot, "wiki", "log.md");

const { removed } = await invalidateStaleLogEntries(logPath, vaultRoot);
if (removed.length === 0) {
  console.log("wiki-log-preflight: no stale registry entries");
} else {
  console.log(`wiki-log-preflight: removed ${removed.length} stale entries`);
  for (const p of removed) console.log(`  - ${p}`);
}
