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

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

test("repo-owned trello bridge queues reschedule moves into repo-owned pipeline state", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-pipeline-"));
  const stateDir = path.join(tempDir, "state");
  fs.mkdirSync(stateDir, { recursive: true });

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
      res.end(
        JSON.stringify({
          success: true,
          status: "ok",
          boardId: "board-1",
          agents: ["system"],
          transitions: 1,
        }),
      );
    }),
  );

  let stdout = "";
  let stderr = "";
  const port = 19194;
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
  bridge.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  bridge.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server)]);
  });

  await waitFor(`http://127.0.0.1:${port}/health`);

  const response = await fetch(`http://127.0.0.1:${port}/trello?token=bridge-test`, {
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
            name: "P2 - Reschedule this",
            shortLink: "short-1",
          },
          old: { idList: "list-old" },
          listBefore: { name: "Backlog" },
          listAfter: { name: "Reschedule" },
        },
      },
    }),
  });

  assert.equal(
    response.status,
    200,
    `bridge stdout:\n${stdout}\nbridge stderr:\n${stderr}`,
  );

  const pendingEntries = fs
    .readFileSync(path.join(stateDir, "actionable_pending.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(pendingEntries.length, 1);
  assert.equal(pendingEntries[0].kind, "trello_card_moved_to_reschedule");
  assert.equal(pendingEntries[0].source, "trello-webhook-bridge");

  const wakeEntries = fs
    .readFileSync(path.join(stateDir, "wakes.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(wakeEntries.length, 1);
  assert.equal(wakeEntries[0].target, null);
  assert.equal(wakeEntries[0].wake.reason, "handled_by_queue_worker");

  assert.equal(gatewayCalls.some((call) => call.operation === "status"), true);
});

test("repo-owned trello bridge wakes Ubi with backlog intake procedure for new Backlog cards", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-pipeline-backlog-intake-"));
  const stateDir = path.join(tempDir, "state");
  const hookConfigDir = path.join(tempDir, "openclaw");
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(hookConfigDir, { recursive: true });
  fs.writeFileSync(
    path.join(hookConfigDir, "openclaw.json"),
    JSON.stringify({ hooks: { token: "hook-test-token" } }),
  );

  const hookBodies = [];
  const hookServer = await listen(
    http.createServer(async (req, res) => {
      const body = JSON.parse((await getTextBody(req)) || "{}");
      hookBodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }),
  );

  const gateway = await listen(
    http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/healthz") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, boardId: "board-1", agents: ["system"], transitions: 1 }));
    }),
  );

  let stdout = "";
  let stderr = "";
  const port = 19196;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      TRELLO_BRIDGE_TOKEN: "bridge-test",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_PIPELINE_STATE_DIR: stateDir,
      OPENCLAW_CONFIG: path.join(hookConfigDir, "openclaw.json"),
      OPENCLAW_HOOK_URL: `${hookServer.url}/hooks/agent`,
      TRELLO_API_KEY: "",
      TRELLO_API_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  bridge.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  bridge.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server), closeServer(hookServer.server)]);
  });

  await waitFor(`http://127.0.0.1:${port}/health`);

  const response = await fetch(`http://127.0.0.1:${port}/trello?token=bridge-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: {
        id: "action-backlog-create",
        type: "createCard",
        memberCreator: { username: "adriellopez1" },
        data: {
          card: {
            id: "card-backlog-1",
            name: "Test backlog intake card",
            shortLink: "backlog-1",
          },
          list: { name: "Backlog" },
          text: "Test backlog intake card",
        },
      },
    }),
  });

  assert.equal(response.status, 200, `bridge stdout:\n${stdout}\nbridge stderr:\n${stderr}`);

  const hookWaitStart = Date.now();
  while (hookBodies.length === 0 && Date.now() - hookWaitStart < 5_000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(hookBodies.length, 1, `expected one hook wake, got ${hookBodies.length}`);

  const hookText = hookBodies[0].message || hookBodies[0].text || "";
  assert.match(hookText, /Procedure \(follow in order\):/);
  assert.match(hookText, /Original Request:/);
  assert.match(hookText, /Peer Review:/);
  assert.match(hookText, /Do not move to Blocked while waiting for @marcostheai peer review/);
  assert.equal(hookBodies[0].agentId, "main");

  const pendingEntries = fs
    .readFileSync(path.join(stateDir, "actionable_pending.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.equal(pendingEntries.length, 1);
  assert.equal(pendingEntries[0].kind, "trello_card_created");
  assert.equal(pendingEntries[0].listName, "Backlog");
});
