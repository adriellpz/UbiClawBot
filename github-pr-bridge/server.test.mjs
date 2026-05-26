import { createHmac } from "node:crypto";
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

test("gateway-backed config accepts signed PR webhook and wakes OpenClaw", async (t) => {
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
            lists: [
              { id: "list-review", name: "Review", closed: false },
              { id: "list-done", name: "Done", closed: false },
            ],
          };
          break;
        case "create_card":
          payload = {
            success: true,
            created: true,
            cardId: "card-123",
            cardName: body.params?.name,
            list: body.params?.listName,
            url: "https://trello.example/c/card-123",
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

  let stdout = "";
  let stderr = "";
  const bridgePort = 19192;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GITHUB_PR_BRIDGE_PORT: String(bridgePort),
      GITHUB_PR_WEBHOOK_SECRET: "test-secret",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_GATEWAY_AGENT_ID: "main",
      TRELLO_BOARD_ID: "board123",
      OPENCLAW_HOOK_URL: `${hook.url}/hooks/agent`,
      OPENCLAW_HOOK_TOKEN: "hook-test",
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
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server), closeServer(hook.server)]);
  });

  await waitFor(`http://127.0.0.1:${bridgePort}/healthz`);

  const payload = {
    action: "opened",
    pull_request: {
      number: 14,
      html_url: "https://github.com/adriellpz/UbiClawBot/pull/14",
      title: "Wake Ubi through gateway",
      user: { login: "adriellpz" },
      head: { ref: "feature/gateway" },
      base: { ref: "main" },
      draft: false,
      labels: [],
    },
  };
  const body = JSON.stringify(payload);
  const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;

  const res = await fetch(`http://127.0.0.1:${bridgePort}/github-pr`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": signature,
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-1",
    },
    body,
  });

  const responseBody = await res.json();

  assert.equal(
    res.status,
    200,
    `bridge stdout:\n${stdout}\nbridge stderr:\n${stderr}\nresponse:\n${JSON.stringify(responseBody, null, 2)}`,
  );
  assert.equal(responseBody.ok, true);
  assert.equal(responseBody.mode, "created");
  assert.deepEqual(responseBody.wake, { ok: true });

  assert.deepEqual(
    gatewayCalls.map((call) => call.operation),
    ["search", "board_lists", "board_lists", "create_card"],
  );
  assert.equal(gatewayCalls[0].agentId, "main");
  assert.match(gatewayCalls[0].params.query, /\/pull\/14/);
  assert.match(gatewayCalls[0].params.query, /board:board123/);
  const createCardCall = gatewayCalls.find((call) => call.operation === "create_card");
  assert.equal(createCardCall?.params.listName, "Review");
  assert.equal(createCardCall?.params.name, "P2 - Review PR 14");
  assert.match(createCardCall?.params.desc, /Wake Ubi through gateway/);

  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].authorization, "Bearer hook-test");
  assert.equal(hookCalls[0].body.agentId, "main");
  assert.equal(hookCalls[0].body.sessionKey, "hook:github-pr:14");
  assert.match(hookCalls[0].body.message, /github_pr_review_requested/);
});
