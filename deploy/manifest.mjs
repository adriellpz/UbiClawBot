import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function loadDeployManifest() {
  const manifestPath = path.join(repoRoot, "deploy/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.version !== 1) {
    throw new Error(`deploy/manifest.json: unsupported version ${manifest.version}`);
  }
  return manifest;
}

export function dropletPath(manifest, relativePath) {
  const root = manifest.dropletRoot.replace(/\/$/, "");
  return `${root}/${relativePath.replace(/^\//, "")}`;
}
