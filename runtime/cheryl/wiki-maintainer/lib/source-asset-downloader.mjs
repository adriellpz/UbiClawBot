import { mkdir, readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { WIKI_SOURCES_ASSETS_REL } from "./wiki-layout.mjs";

const IMAGE_URL_RE = /!\[[^\]]*]\((https?:\/\/[^)]+)\)/g;

function sourceSlug(sourceRelPath) {
  const base = path.posix.basename(sourceRelPath, ".md");
  return base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "clip";
}

function assetFilename(url) {
  const ext = path.extname(new URL(url).pathname) || ".bin";
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 12);
  return `${hash}${ext}`;
}

export async function downloadSourceAssets(sourcePath, vaultRoot, { fetchImpl = fetch } = {}) {
  const sourceRel = path.relative(vaultRoot, sourcePath).replace(/\\/g, "/");
  const markdown = await readFile(sourcePath, "utf8");
  const slug = sourceSlug(sourceRel);
  const assetDir = path.join(vaultRoot, WIKI_SOURCES_ASSETS_REL, slug);
  await mkdir(assetDir, { recursive: true });

  const downloaded = [];
  const skipped = [];
  let match;
  while ((match = IMAGE_URL_RE.exec(markdown)) !== null) {
    const url = match[1];
    const filename = assetFilename(url);
    const dest = path.join(assetDir, filename);
    try {
      await access(dest);
      skipped.push(path.relative(vaultRoot, dest).replace(/\\/g, "/"));
      continue;
    } catch {
      // download
    }
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`fetch failed ${response.status} for ${url}`);
    const buf = Buffer.from(await response.arrayBuffer());
    await writeFile(dest, buf);
    downloaded.push(path.relative(vaultRoot, dest).replace(/\\/g, "/"));
  }

  return { downloaded, skipped };
}
