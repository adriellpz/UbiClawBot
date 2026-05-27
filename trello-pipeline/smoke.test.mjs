import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

function getTextBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

async function waitFor(url, timeoutMs = 5_000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function createGogStub(tempDir) {
  const logPath = path.join(tempDir, "gog-log.jsonl");
  const scriptPath = path.join(tempDir, "gog");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";
const args = process.argv.slice(2);
fs.appendFileSync(process.env.GOG_STUB_LOG_PATH, JSON.stringify({ args }) + "\\n");
if (args[0] === "calendar" && args[1] === "events") {
  process.stdout.write(JSON.stringify({ events: [] }));
  process.exit(0);
}
if (args[0] === "calendar" && args[1] === "create") {
  process.stdout.write(JSON.stringify({ event: { htmlLink: "https://www.google.com/calendar/event?eid=smoke-1" } }));
  process.exit(0);
}
if (args[0] === "calendar" && args[1] === "update") {
  process.stdout.write(JSON.stringify({ event: { htmlLink: "https://www.google.com/calendar/event?eid=smoke-1" } }));
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "list") {
  process.stdout.write("ok");
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: true }));
`,
    { mode: 0o755 },
  );
  return { scriptPath, logPath };
}

test("repo-owned trello pipeline smoke test handles reschedule flow end to end", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-pipeline-smoke-"));
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });
  const gog = createGogStub(tempDir);

  const gatewayCalls = [];
  const gateway = await listen(
    http.createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      const body = JSON.parse((await getTextBody(req)) || "{}");
      gatewayCalls.push(body);

      res.writeHead(200, { "content-type": "application/json" });
      switch (body.operation) {
        case "status":
          res.end(JSON.stringify({ success: true, boardId: "board-1", agents: ["system"], transitions: 10 }));
          return;
        case "get":
          res.end(
            JSON.stringify({
              success: true,
              card: {
                id: "card-1",
                name: "P2 - Smoke reschedule",
                shortUrl: "https://trello.com/c/card-1",
                shortLink: "card-1",
                desc: "Time needed: 30",
                labels: [],
                closed: false,
              },
            }),
          );
          return;
        case "board_lists":
          res.end(
            JSON.stringify({
              success: true,
              lists: [
                { id: "scheduled-1", name: "Scheduled", closed: false },
                { id: "missed-1", name: "Missed", closed: false },
                { id: "routine-1", name: "Routine", closed: false },
              ],
            }),
          );
          return;
        default:
          res.end(JSON.stringify({ success: true }));
      }
    }),
  );

  const port = 19197;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      TRELLO_BRIDGE_TOKEN: "bridge-test",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_PIPELINE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server)]);
  });

  await waitFor(`http://127.0.0.1:${port}/health`);

  const webhookResponse = await fetch(`http://127.0.0.1:${port}/trello?token=bridge-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: {
        id: "action-1",
        type: "updateCard",
        memberCreator: { username: "adriellopez1" },
        data: {
          card: {
            id: "card-1",
            name: "P2 - Smoke reschedule",
            shortLink: "card-1",
          },
          old: { idList: "backlog-1" },
          listBefore: { name: "Backlog" },
          listAfter: { name: "Reschedule" },
        },
      },
    }),
  });
  assert.equal(webhookResponse.status, 200);

  const worker = spawn(process.execPath, ["trello_queue_worker.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GOG_BIN: gog.scriptPath,
      GOG_STUB_LOG_PATH: gog.logPath,
      GOG_KEYRING_PASSWORD: "test-password",
      GOOGLE_CALENDAR_ID: "calendar@example.com",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_PIPELINE_ONE_SHOT: "1",
      TRELLO_PIPELINE_STATE_DIR: stateDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await stopChild(worker);
  });

  await once(worker, "exit");

  const handledIds = readJson(path.join(stateDir, "actionable_handled_ids.json"), []);
  assert.deepEqual(handledIds, ["action-1"]);
  assert.equal(gatewayCalls.some((call) => call.operation === "move"), true);
  assert.equal(gatewayCalls.some((call) => call.operation === "update"), true);

  const gogCalls = fs
    .readFileSync(gog.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(gogCalls.some((call) => call.args[0] === "calendar" && call.args[1] === "create"), true);
});
