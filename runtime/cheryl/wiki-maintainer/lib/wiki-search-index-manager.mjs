import { spawn } from "node:child_process";

export async function reindexWikiSearch(vaultRoot, { paths, qmdPath = "qmd" } = {}) {
  return new Promise((resolve) => {
    const child = spawn(qmdPath, ["--version"], { stdio: "ignore" });
    child.on("error", () => {
      resolve({ ok: false, skipped: true, reason: "qmd not installed (WM-09 HITL)" });
    });
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, skipped: true, reason: "qmd not available" });
        return;
      }
      resolve({ ok: true, paths: paths ?? ["wiki/"], vaultRoot });
    });
  });
}
