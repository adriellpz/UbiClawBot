import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  if (!server?.listening) return;
  server.close();
  await once(server, "close");
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for condition");
}

function createGogStub(tempDir) {
  const scriptPath = path.join(tempDir, "gog");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "calendar" && args[1] === "events") {
  process.stdout.write(JSON.stringify({ events: [] }));
} else if (args[0] === "calendar" && (args[1] === "create" || args[1] === "update")) {
  process.stdout.write(JSON.stringify({ event: { htmlLink: "https://calendar.google.com/event?eid=test-1" } }));
} else {
  process.stdout.write(JSON.stringify({ ok: true }));
}
`,
    { mode: 0o755 },
  );
  return scriptPath;
}

test("repo-owned queue worker dispatches reschedule handlers from repo-owned state", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-pipeline-worker-"));
  const stateDir = path.join(tempDir, "state");
  const gogStub = createGogStub(tempDir);
  fs.mkdirSync(stateDir, { recursive: true });

  fs.writeFileSync(
    path.join(stateDir, "actionable_pending.jsonl"),
    `${JSON.stringify({
      actionId: "action-1",
      kind: "trello_card_moved_to_reschedule",
      cardId: "card-1",
      cardName: "P2 - Reschedule this",
      fromListName: "Backlog",
    })}\n`,
  );

  const gatewayCalls = [];
  const gateway = await listen(
    http.createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      gatewayCalls.push(body);

      res.writeHead(200, { "content-type": "application/json" });
      if (body.operation === "get") {
        res.end(JSON.stringify({ success: true, card: { id: "card-1", name: "P2 - Reschedule this", shortUrl: "https://trello.com/c/card-1", shortLink: "card-1", desc: "Time needed: 30", labels: [], closed: false } }));
        return;
      }
      if (body.operation === "board_lists") {
        res.end(JSON.stringify({ success: true, lists: [{ id: "s1", name: "Scheduled" }, { id: "m1", name: "Missed" }, { id: "r1", name: "Routine" }] }));
        return;
      }
      res.end(JSON.stringify({ success: true }));
    }),
  );

  const worker = spawn(process.execPath, ["trello_queue_worker.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GOG_BIN: gogStub,
      GOG_KEYRING_PASSWORD: "test",
      GOOGLE_CALENDAR_ID: "cal@example.com",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_PIPELINE_ONE_SHOT: "1",
      TRELLO_PIPELINE_POLL_MS: "10",
      TRELLO_PIPELINE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(worker), closeServer(gateway.server)]);
  });

  await waitFor(() => worker.exitCode !== null);

  const handledIds = readJson(path.join(stateDir, "actionable_handled_ids.json"), []);
  assert.deepEqual(handledIds, ["action-1"]);
  assert.equal(gatewayCalls.some((call) => call.operation === "get"), true);
  assert.equal(gatewayCalls.some((call) => call.operation === "board_lists"), true);
});
