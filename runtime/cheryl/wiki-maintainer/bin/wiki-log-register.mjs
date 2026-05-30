#!/usr/bin/env node
import path from "node:path";
import { upsertCompletionRegistryEntries } from "../lib/wiki-log-registry.mjs";

const vaultRoot = process.argv[2] ?? process.env.OPENCLAW_AGENT_VAULT_DIR;
const wikiPaths = process.argv.slice(3);
if (!vaultRoot || wikiPaths.length === 0) {
  console.error("usage: wiki-log-register.mjs <vault-root> <wiki/path1.md> [wiki/path2.md ...]");
  process.exit(1);
}

const logPath = path.join(vaultRoot, "wiki", "log.md");
const { updated } = await upsertCompletionRegistryEntries(logPath, vaultRoot, wikiPaths);
if (updated.length === 0) {
  console.log("wiki-log-register: no registry entries updated");
} else {
  console.log(`wiki-log-register: updated ${updated.length} entries`);
  for (const p of updated) console.log(`  - ${p}`);
}
