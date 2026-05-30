import { readFile, writeFile } from "node:fs/promises";

const DEFAULT_CONFIG = { curatorIdleStreak: 0 };

export async function readWikiMaintainerConfig(configPath) {
  try {
    const raw = await readFile(configPath, "utf8");
    return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export async function writeWikiMaintainerConfig(configPath, config) {
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function getIdleStreak(configPath) {
  const config = await readWikiMaintainerConfig(configPath);
  return config.curatorIdleStreak ?? 0;
}

export async function incrementIdleStreak(configPath) {
  const config = await readWikiMaintainerConfig(configPath);
  const next = (config.curatorIdleStreak ?? 0) + 1;
  config.curatorIdleStreak = next;
  await writeWikiMaintainerConfig(configPath, config);
  return { streak: next, triggerFullLint: next >= 4 };
}

export async function resetIdleStreak(configPath) {
  const config = await readWikiMaintainerConfig(configPath);
  config.curatorIdleStreak = 0;
  await writeWikiMaintainerConfig(configPath, config);
  return { streak: 0 };
}
