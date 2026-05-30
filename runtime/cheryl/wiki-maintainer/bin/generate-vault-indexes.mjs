#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateVaultIndexes } from "../lib/vault-index-generator.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  let vaultRoot = process.env.OPENCLAW_AGENT_VAULT_DIR;
  let folders;

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--root") {
      vaultRoot = path.resolve(argv[++i] ?? "");
    } else if (arg === "--folders") {
      folders = (argv[++i] ?? "")
        .split(",")
        .map((f) => f.trim())
        .filter(Boolean);
    } else if (!arg.startsWith("-")) {
      vaultRoot = path.resolve(arg);
    }
  }

  return { vaultRoot, folders };
}

const { vaultRoot, folders } = parseArgs(process.argv);
if (!vaultRoot) {
  console.error("usage: generate-vault-indexes.mjs <vault-root> [--folders wiki/reports,...]");
  process.exit(1);
}
const results = await generateVaultIndexes(vaultRoot, {
  generatedAt: new Date().toISOString(),
  folders,
});

for (const { path: indexPath } of results) {
  console.log(`generate-vault-indexes: wrote ${indexPath}`);
}
