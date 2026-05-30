import path from "node:path";
import { invalidateStaleLogEntries } from "./wiki-log-preflight.mjs";
import { appendWikiChronicle } from "./wiki-log-registry.mjs";
import { listRawInputDrops, listMaintenanceBacklog, assessIdleConditions } from "./wiki-maintenance-backlog.mjs";
import { generateVaultIndexes } from "./vault-index-generator.mjs";
import { reindexWikiSearch } from "./wiki-search-index-manager.mjs";
import {
  incrementIdleStreak,
  resetIdleStreak,
} from "./curator-idle-streak.mjs";
import { runFullWikiLint } from "./wiki-lint.mjs";
import { ingestOnePendingSource } from "./raw-source-ingest.mjs";

function collectTouched(...results) {
  const touched = [];
  for (const result of results) {
    if (result?.touched?.length) {
      touched.push(...result.touched);
    }
  }
  return [...new Set(touched)];
}

function anyDidWork(...results) {
  return results.some((result) => result?.didWork);
}

function touchedFoldersFromPaths(touched) {
  const folders = new Set();
  for (const rel of touched) {
    const parts = rel.replace(/\\/g, "/").split("/");
    if (parts.length >= 2 && parts[0] === "wiki") {
      folders.add(`wiki/${parts[1]}`);
    }
  }
  return folders.size ? [...folders] : undefined;
}

async function defaultPreflight(vaultRoot) {
  const logPath = path.join(vaultRoot, "wiki", "log.md");
  await invalidateStaleLogEntries(logPath, vaultRoot);
}

async function defaultRawInputIngest(vaultRoot) {
  const drops = await listRawInputDrops(vaultRoot);
  return { didWork: false, pending: drops };
}

async function defaultRawSourceIngest(vaultRoot, _configPath, deps = {}) {
  return ingestOnePendingSource(vaultRoot, { fetchImpl: deps.fetchImpl });
}

async function defaultMaintenance(vaultRoot) {
  const backlog = await listMaintenanceBacklog(vaultRoot);
  return { didWork: false, pending: backlog };
}

async function defaultIndexGeneration(vaultRoot, { touched = [] } = {}) {
  const folders = touchedFoldersFromPaths(touched);
  await generateVaultIndexes(vaultRoot, folders ? { folders } : {});
}

async function defaultSearchReindex(vaultRoot, { touched = [] } = {}) {
  await reindexWikiSearch(vaultRoot, { paths: touched.length ? touched : ["wiki/"] });
}

async function defaultIdleHandling(vaultRoot, configPath, { didWork }, idleDeps = {}) {
  const increment = idleDeps.incrementIdleStreak ?? incrementIdleStreak;
  const reset = idleDeps.resetIdleStreak ?? resetIdleStreak;
  const lint = idleDeps.runFullWikiLint ?? runFullWikiLint;

  if (didWork) {
    await reset(configPath);
    return { action: "reset" };
  }

  const status = await assessIdleConditions(vaultRoot);
  if (status.idle) {
    const incrementResult = await increment(configPath);
    if (incrementResult.triggerFullLint) {
      await lint(vaultRoot);
      await reset(configPath);
      return { ...incrementResult, action: "fullLint" };
    }
    return { ...incrementResult, action: "increment", reply: "NO_REPLY" };
  }

  return { action: "none" };
}

async function defaultChronicleAppend(vaultRoot, { touched = [] } = {}) {
  if (!touched.length) return;
  const logPath = path.join(vaultRoot, "wiki", "log.md");
  await appendWikiChronicle(logPath, {
    eventType: "maintenance",
    touched,
  });
}

export async function runCuratorCronTick(vaultRoot, configPath, deps = {}) {
  const runPreflight = deps.runPreflight ?? defaultPreflight;
  const runRawInputIngest = deps.runRawInputIngest ?? defaultRawInputIngest;
  const runRawSourceIngest = deps.runRawSourceIngest ?? defaultRawSourceIngest;
  const runMaintenance = deps.runMaintenance ?? defaultMaintenance;
  const runIndexGeneration = deps.runIndexGeneration ?? defaultIndexGeneration;
  const runSearchReindex = deps.runSearchReindex ?? defaultSearchReindex;
  const runIdleHandling = deps.runIdleHandling ?? defaultIdleHandling;
  const runChronicleAppend = deps.runChronicleAppend ?? defaultChronicleAppend;

  await runPreflight(vaultRoot, configPath);

  const rawInputResult = await runRawInputIngest(vaultRoot, configPath);
  const rawSourceResult = await runRawSourceIngest(vaultRoot, configPath, deps);
  const maintenanceResult = await runMaintenance(vaultRoot, configPath);

  const touched = collectTouched(rawInputResult, rawSourceResult, maintenanceResult);
  const didWork = anyDidWork(rawInputResult, rawSourceResult, maintenanceResult);

  await runIndexGeneration(vaultRoot, { touched, configPath });
  await runSearchReindex(vaultRoot, { touched, configPath });

  const idleDeps = {
    incrementIdleStreak: deps.incrementIdleStreak,
    resetIdleStreak: deps.resetIdleStreak,
    runFullWikiLint: deps.runFullWikiLint,
  };
  const idleResult = await runIdleHandling(vaultRoot, configPath, { didWork }, idleDeps);

  if (didWork) {
    await runChronicleAppend(vaultRoot, { touched, configPath });
  }

  return { didWork, touched, idle: idleResult };
}
