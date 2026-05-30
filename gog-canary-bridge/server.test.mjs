import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

function getJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
  };
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, "close");
}

async function waitFor(url, timeoutMs = 5_000) {
  const start = Date.now();
  let lastError = null;
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      lastError = new Error(`health check returned ${res.status}`);
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

test("gog auth failure creates a Trello card and wakes Ubi", async (t) => {
  const gatewayCalls = [];
  const hookCalls = [];

  const gateway = await listen(
    http.createServer(async (req, res) => {
      assert.equal(req.headers.authorization, "Bearer gw-test");
      const body = await getJsonBody(req);
      gatewayCalls.push(body);

      let payload = { success: true };
      switch (body.operation) {
        case "search":
          payload = { success: true, cards: [] };
          break;
        case "board_lists":
          payload = {
            success: true,
            lists: [{ id: "list-backlog", name: "Backlog", closed: false }],
          };
          break;
        case "create_card":
          payload = {
            success: true,
            created: true,
            cardId: "card-gog-1",
            cardName: body.params?.name,
            list: body.params?.listName,
            shortUrl: "gog-card-1",
          };
          break;
        default:
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: `Unexpected operation ${body.operation}` }));
          return;
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }),
  );

  const hook = await listen(
    http.createServer(async (req, res) => {
      hookCalls.push({
        authorization: req.headers.authorization,
        body: await getJsonBody(req),
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }),
  );

  const bridgePort = 19220;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gog-canary-bridge-test-"));
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GOG_CANARY_BRIDGE_PORT: String(bridgePort),
      GOG_CANARY_ALLOW_SIMULATE: "1",
      GOG_CANARY_SKIP_SCHEDULE: "1",
      GOG_CANARY_STATE_DIR: stateDir,
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_GATEWAY_AGENT_ID: "main",
      TRELLO_INTAKE_LIST_ID: "list-backlog",
      OPENCLAW_HOOK_URL: `${hook.url}/hooks/agent`,
      OPENCLAW_HOOK_TOKEN: "hook-test",
      OPENCLAW_HOOK_AGENT_ID: "main",
      OPENCLAW_HOOK_SESSION_PREFIX: "hook:gog-canary:",
      GOG_ACCOUNT: "ubitheai@gmail.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server), closeServer(hook.server)]);
  });

  await waitFor(`http://127.0.0.1:${bridgePort}/healthz`);

  const response = await fetch(`http://127.0.0.1:${bridgePort}/hooks/gog-canary/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "invalid_grant: token revoked" }),
  });

  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const result = JSON.parse(responseText);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "created");
  assert.ok(gatewayCalls.some((call) => call.operation === "search"));
  const createCardCall = gatewayCalls.find((call) => call.operation === "create_card");
  assert.ok(createCardCall);
  assert.match(createCardCall.params.name, /GOG Auth: ubitheai re-auth needed/);
  assert.match(createCardCall.params.desc, /GOG canary account: ubitheai@gmail.com/);
  assert.match(createCardCall.params.desc, /invalid_grant: token revoked/);

  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].body.agentId, "main");
  assert.match(hookCalls[0].body.message, /gog_auth_canary_failed/);
  assert.match(hookCalls[0].body.message, /Diagnose the auth failure/);
  assert.equal(hookCalls[0].body.sessionKey, "hook:gog-canary:ubitheai@gmail.com");
});

test("gog auth failure dedupes an open card for the same account", async (t) => {
  const gatewayCalls = [];
  const hookCalls = [];

  const gateway = await listen(
    http.createServer(async (req, res) => {
      const body = await getJsonBody(req);
      gatewayCalls.push(body);

      let payload = { success: true };
      if (body.operation === "search") {
        payload = {
          success: true,
          cards: [
            {
              id: "card-existing",
              desc: "GOG canary account: ubitheai@gmail.com",
              closed: false,
              idList: "list-backlog",
              shortUrl: "existing-gog-card",
            },
          ],
        };
      } else if (body.operation === "board_lists") {
        payload = {
          success: true,
          lists: [{ id: "list-backlog", name: "Backlog", closed: false }],
        };
      }

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    }),
  );

  const hook = await listen(
    http.createServer(async (req, res) => {
      hookCalls.push(await getJsonBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }),
  );

  const bridgePort = 19221;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "gog-canary-bridge-dedupe-"));
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GOG_CANARY_BRIDGE_PORT: String(bridgePort),
      GOG_CANARY_ALLOW_SIMULATE: "1",
      GOG_CANARY_SKIP_SCHEDULE: "1",
      GOG_CANARY_STATE_DIR: stateDir,
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_INTAKE_LIST_ID: "list-backlog",
      OPENCLAW_HOOK_URL: `${hook.url}/hooks/agent`,
      OPENCLAW_HOOK_TOKEN: "hook-test",
      GOG_ACCOUNT: "ubitheai@gmail.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server), closeServer(hook.server)]);
  });

  await waitFor(`http://127.0.0.1:${bridgePort}/healthz`);

  const response = await fetch(`http://127.0.0.1:${bridgePort}/hooks/gog-canary/simulate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error: "disabled_client" }),
  });

  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const result = JSON.parse(responseText);
  assert.equal(result.mode, "updated");
  assert.equal(gatewayCalls.some((call) => call.operation === "create_card"), false);
  assert.equal(hookCalls.length, 1);
});
