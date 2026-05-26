#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE = process.env.TRELLO_PIPELINE_STATE_DIR || "/var/lib/trello-pipeline";
const PID_FILE = path.join(STATE, "queue_worker.pid");
const MONITOR_PID_FILE = path.join(STATE, "start_queue_worker.pid");
const LOG_FILE = path.join(STATE, "queue_worker.log");
const LOCK_FILE = path.join(STATE, "queue_worker.monitor.lock");
const WORKER_SCRIPT = path.join(__dirname, "trello_queue_worker.mjs");

fs.mkdirSync(STATE, { recursive: true });

function alive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  try {
    const raw = fs.readFileSync(LOCK_FILE, "utf8").trim();
    const sep = raw.lastIndexOf(":");
    if (sep <= 0) return null;
    return { host: raw.slice(0, sep), pid: Number(raw.slice(sep + 1)) };
  } catch {
    return null;
  }
}

function isQueueWorkerMonitor(pid) {
  if (!alive(pid)) return false;
  try {
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    return cmd.includes("start_queue_worker.mjs");
  } catch {
    return false;
  }
}

function acquireMonitorLock() {
  const payload = `${os.hostname()}:${process.pid}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_FILE, payload, { flag: "wx" });
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }

    const current = readLock();
    if (current && current.host === os.hostname() && isQueueWorkerMonitor(current.pid)) {
      console.log(`queue worker monitor already running pid=${current.pid}`);
      process.exit(process.env.OPENCLAW_TRELLO_QUEUE_WORKER_SERVICE === "1" ? 1 : 0);
    }

    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
  }

  console.log("queue worker monitor lock busy");
  process.exit(process.env.OPENCLAW_TRELLO_QUEUE_WORKER_SERVICE === "1" ? 1 : 0);
}

function clearStalePidFile(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, "utf8").trim());
    if (!alive(pid)) fs.unlinkSync(pidFile);
  } catch {}
}

acquireMonitorLock();
clearStalePidFile(PID_FILE);
clearStalePidFile(MONITOR_PID_FILE);

fs.writeFileSync(MONITOR_PID_FILE, String(process.pid));
process.on("exit", () => {
  try {
    fs.unlinkSync(MONITOR_PID_FILE);
  } catch {}
});
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const output = fs.openSync(LOG_FILE, "a");
const append = (message) => {
  fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
};

let restartCount = 0;
const MAX_RESTARTS = 50;
const RESTART_DELAY_MS = 2000;

async function run() {
  while (restartCount < MAX_RESTARTS) {
    const child = spawn(process.execPath, [WORKER_SCRIPT], {
      cwd: __dirname,
      detached: false,
      stdio: ["ignore", output, output],
      env: { ...process.env, OPENCLAW_TRELLO_QUEUE_WORKER_STARTED_BY: "startup-hook" },
    });
    fs.writeFileSync(PID_FILE, String(child.pid));
    restartCount += 1;
    append(`queue worker started pid=${child.pid} restart=${restartCount}`);

    await new Promise((resolve) =>
      child.on("exit", (code) => {
        append(`queue worker exited pid=${child.pid} code=${code} restart=${restartCount}`);
        resolve();
      }),
    );

    if (restartCount >= MAX_RESTARTS) {
      append("queue worker reached max restarts - giving up");
      break;
    }

    await new Promise((resolve) => setTimeout(resolve, RESTART_DELAY_MS));
  }
}

run().catch((error) => {
  append(`queue worker monitor fatal: ${error?.message || String(error)}`);
  process.exit(1);
});
