import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export function applyMappings(text, mappings) {
  let next = text;
  for (const { from, to } of mappings) {
    next = next.replace(from, to);
  }
  return { next };
}

async function walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(abs)));
    } else {
      files.push(abs);
    }
  }
  return files;
}

export async function rewriteVaultPaths({ root, mappings }) {
  const files = await walkFiles(root);
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const { next } = applyMappings(text, mappings);
    if (next !== text) {
      await writeFile(file, next, "utf8");
    }
  }
}

export async function scanLegacyPaths({ root }) {
  const files = await walkFiles(root);
  const matches = [];
  for (const file of files) {
    const text = await readFile(file, "utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (/Docs\//.test(lines[i])) {
        matches.push({ file, line: i + 1, text: lines[i] });
      }
    }
  }
  return { matches };
}
