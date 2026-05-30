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

test("Adriel gmail hook creates a Trello card and wakes Ubi", async (t) => {
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
            cardId: "card-email-1",
            cardName: body.params?.name,
            list: body.params?.listName,
            shortUrl: "email-card-1",
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

  const bridgePort = 19210;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GMAIL_HOOK_BRIDGE_PORT: String(bridgePort),
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_GATEWAY_AGENT_ID: "main",
      TRELLO_INTAKE_LIST_ID: "list-backlog",
      OPENCLAW_HOOK_URL: `${hook.url}/hooks/agent`,
      OPENCLAW_HOOK_TOKEN: "hook-test",
      OPENCLAW_HOOK_AGENT_ID: "main",
      OPENCLAW_HOOK_SESSION_PREFIX: "hook:gmail:",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server), closeServer(hook.server)]);
  });

  await waitFor(`http://127.0.0.1:${bridgePort}/healthz`);

  const payload = {
    messages: [
      {
        id: "msg-adriel-1",
        from: "Adriel <adriellpz@gmail.com>",
        subject: "Please schedule dentist",
        snippet: "Can you find a slot next week?",
        body: "Can you find a slot next week?",
      },
    ],
  };

  const response = await fetch(`http://127.0.0.1:${bridgePort}/hooks/gmail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  const result = JSON.parse(responseText);
  assert.equal(result.ok, true);
  assert.equal(result.mode, "created");
  assert.ok(gatewayCalls.some((call) => call.operation === "search"));
  const createCardCall = gatewayCalls.find((call) => call.operation === "create_card");
  assert.ok(createCardCall);
  assert.match(createCardCall.params.name, /Email: Please schedule dentist/);
  assert.match(createCardCall.params.desc, /Gmail message id: msg-adriel-1/);

  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].body.agentId, "main");
  assert.match(hookCalls[0].body.message, /gmail_hook_email_received/);
  assert.match(hookCalls[0].body.message, /Only Adriel can send you these hooks/);
  assert.match(hookCalls[0].body.message, /Action the item as described in the email/);
  assert.equal(hookCalls[0].body.sessionKey, "hook:gmail:msg-adriel-1");
});

test("non-Adriel gmail hook is ignored without creating a card or waking Ubi", async (t) => {
  const gatewayCalls = [];
  const hookCalls = [];

  const gateway = await listen(
    http.createServer(async (req, res) => {
      gatewayCalls.push(await getJsonBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ success: true, cards: [] }));
    }),
  );

  const hook = await listen(
    http.createServer(async (req, res) => {
      hookCalls.push(await getJsonBody(req));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }),
  );

  const bridgePort = 19211;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GMAIL_HOOK_BRIDGE_PORT: String(bridgePort),
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_INTAKE_LIST_ID: "list-backlog",
      OPENCLAW_HOOK_URL: `${hook.url}/hooks/agent`,
      OPENCLAW_HOOK_TOKEN: "hook-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server), closeServer(hook.server)]);
  });

  await waitFor(`http://127.0.0.1:${bridgePort}/healthz`);

  const response = await fetch(`http://127.0.0.1:${bridgePort}/hooks/gmail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ id: "msg-stranger-1", from: "stranger@example.com", subject: "spam", body: "buy now" }],
    }),
  });

  const responseText = await response.text();
  assert.equal(response.status, 202, responseText);
  const result = JSON.parse(responseText);
  assert.equal(result.ignored, "sender_not_allowed");
  assert.equal(gatewayCalls.length, 0);
  assert.equal(hookCalls.length, 0);
});
