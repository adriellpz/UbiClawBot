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
            shortUrl: "card-123",
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
      TRELLO_GATEWAY_AGENT_ID: "system",
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
  assert.equal(responseBody.cardUrl, "https://trello.com/c/card-123");
  assert.deepEqual(responseBody.wake, { ok: true });

  assert.deepEqual(
    gatewayCalls.map((call) => call.operation),
    ["search", "board_lists", "board_lists", "create_card"],
  );
  assert.equal(gatewayCalls[0].agentId, "system");
  assert.match(gatewayCalls[0].params.query, /\/pull\/14/);
  assert.match(gatewayCalls[0].params.query, /board:board123/);
  const createCardCall = gatewayCalls.find((call) => call.operation === "create_card");
  assert.equal("cardId" in createCardCall, false);
  assert.equal(createCardCall?.params.listName, "Review");
  assert.equal(createCardCall?.params.name, "P2 - Review PR 14");
  assert.match(createCardCall?.params.desc, /Original Request:/);
  assert.match(createCardCall?.params.desc, /Research:/);
  assert.match(createCardCall?.params.desc, /Peer Review:\n\nWork completed:/);
  assert.match(createCardCall?.params.desc, /https:\/\/github\.com\/adriellpz\/UbiClawBot\/pull\/14/);
  assert.equal(createCardCall?.params.checklists, undefined);

  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].authorization, "Bearer hook-test");
  assert.equal(hookCalls[0].body.agentId, "marcos");
  assert.equal(hookCalls[0].body.sessionKey, "hook:github-pr:14");
  assert.match(hookCalls[0].body.message, /github_pr_review_requested/);
  assert.match(hookCalls[0].body.message, /https:\/\/trello\.com\/c\/card-123/);
});

test("gateway search normalizes shortUrl when updating an existing PR card", async (t) => {
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
          payload = {
            success: true,
            cards: [
              {
                id: "card-existing",
                idList: "list-review",
                name: "P2 - Review PR 14",
                desc: "PR: https://github.com/adriellpz/UbiClawBot/pull/14",
                closed: false,
                shortUrl: "card-existing",
              },
            ],
          };
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
        case "comment":
          payload = { success: true, commented: true };
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
  const bridgePort = 19193;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GITHUB_PR_BRIDGE_PORT: String(bridgePort),
      GITHUB_PR_WEBHOOK_SECRET: "test-secret",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_GATEWAY_AGENT_ID: "system",
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
    action: "synchronize",
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
      "x-github-delivery": "delivery-2",
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
  assert.equal(responseBody.mode, "updated");
  assert.equal(responseBody.cardUrl, "https://trello.com/c/card-existing");
  assert.deepEqual(responseBody.wake, { ok: true });

  assert.deepEqual(
    gatewayCalls.map((call) => call.operation),
    ["search", "board_lists", "comment"],
  );
  const commentCall = gatewayCalls.find((call) => call.operation === "comment");
  assert.equal(commentCall?.cardId, "card-existing");
  assert.match(commentCall?.params.text, /GitHub update: `synchronize`/);

  assert.equal(hookCalls.length, 1);
  assert.equal(hookCalls[0].authorization, "Bearer hook-test");
  assert.match(hookCalls[0].body.message, /https:\/\/trello\.com\/c\/card-existing/);
});

test("concurrent webhook deliveries for the same PR create exactly one card", async (t) => {
  const gatewayCalls = [];

  const gateway = await listen(
    http.createServer(async (req, res) => {
      const body = await getJsonBody(req);
      gatewayCalls.push(body);

      let payload = { success: true };
      switch (body.operation) {
        case "search":
          // Always report no existing card and add latency so both webhook
          // deliveries overlap before either finishes creating a card.
          await new Promise((resolve) => setTimeout(resolve, 150));
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
            cardId: "card-once",
            cardName: body.params?.name,
            list: body.params?.listName,
            shortUrl: "card-once",
          };
          break;
        case "comment":
          payload = { success: true, commented: true };
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
    http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }),
  );

  let stdout = "";
  let stderr = "";
  const bridgePort = 19194;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GITHUB_PR_BRIDGE_PORT: String(bridgePort),
      GITHUB_PR_WEBHOOK_SECRET: "test-secret",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_GATEWAY_AGENT_ID: "system",
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

  const makePayload = (action) => ({
    action,
    pull_request: {
      number: 21,
      html_url: "https://github.com/adriellpz/UbiClawBot/pull/21",
      title: "Race condition repro",
      user: { login: "adriellpz" },
      head: { ref: "feature/race" },
      base: { ref: "main" },
      draft: false,
      labels: [],
    },
  });

  const post = (action, deliveryId) => {
    const body = JSON.stringify(makePayload(action));
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    return fetch(`http://127.0.0.1:${bridgePort}/github-pr`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
      },
      body,
    });
  };

  // GitHub fires one review_requested event per reviewer; deliver two at once.
  const [resA, resB] = await Promise.all([
    post("review_requested", "delivery-race-1"),
    post("review_requested", "delivery-race-2"),
  ]);

  const bodyA = await resA.json();
  const bodyB = await resB.json();

  assert.equal(resA.status, 200, `A: ${JSON.stringify(bodyA)}\nstderr:\n${stderr}`);
  assert.equal(resB.status, 200, `B: ${JSON.stringify(bodyB)}\nstderr:\n${stderr}`);

  const createCalls = gatewayCalls.filter((call) => call.operation === "create_card");
  assert.equal(
    createCalls.length,
    1,
    `expected exactly one create_card, got ${createCalls.length}\nstderr:\n${stderr}`,
  );

  const modes = [bodyA.mode, bodyB.mode].sort();
  assert.deepEqual(modes, ["created", "updated"], `unexpected modes: ${JSON.stringify(modes)}`);
});

test("the board list-name cache honours a configurable TTL", async (t) => {
  const gatewayCalls = [];

  const gateway = await listen(
    http.createServer(async (req, res) => {
      const body = await getJsonBody(req);
      gatewayCalls.push(body);

      let payload = { success: true };
      switch (body.operation) {
        case "search":
          payload = {
            success: true,
            cards: [
              {
                id: "card-existing",
                idList: "list-review",
                name: "P2 - Review PR 33",
                desc: "PR: https://github.com/adriellpz/UbiClawBot/pull/33",
                closed: false,
                shortUrl: "card-existing",
              },
            ],
          };
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
        case "comment":
          payload = { success: true, commented: true };
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
    http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    }),
  );

  let stderr = "";
  const bridgePort = 19195;
  const bridge = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      GITHUB_PR_BRIDGE_PORT: String(bridgePort),
      GITHUB_PR_WEBHOOK_SECRET: "test-secret",
      TRELLO_GATEWAY_URL: gateway.url,
      TRELLO_GATEWAY_KEY: "gw-test",
      TRELLO_GATEWAY_AGENT_ID: "system",
      TRELLO_BOARD_ID: "board123",
      TRELLO_LIST_CACHE_TTL_MS: "0",
      OPENCLAW_HOOK_URL: `${hook.url}/hooks/agent`,
      OPENCLAW_HOOK_TOKEN: "hook-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  bridge.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  t.after(async () => {
    await Promise.allSettled([stopChild(bridge), closeServer(gateway.server), closeServer(hook.server)]);
  });

  await waitFor(`http://127.0.0.1:${bridgePort}/healthz`);

  const makeBody = (deliveryId) => {
    const payload = {
      action: "synchronize",
      pull_request: {
        number: 33,
        html_url: "https://github.com/adriellpz/UbiClawBot/pull/33",
        title: "Cache TTL repro",
        user: { login: "adriellpz" },
        head: { ref: "feature/cache" },
        base: { ref: "main" },
        draft: false,
        labels: [],
      },
    };
    const body = JSON.stringify(payload);
    const signature = `sha256=${createHmac("sha256", "test-secret").update(body).digest("hex")}`;
    return { body, signature, deliveryId };
  };

  const send = async ({ body, signature, deliveryId }) =>
    fetch(`http://127.0.0.1:${bridgePort}/github-pr`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
      },
      body,
    });

  // Two sequential deliveries. With a 0ms TTL the list-name cache must be
  // refetched each time rather than reused from a previous request.
  const res1 = await send(makeBody("cache-1"));
  assert.equal(res1.status, 200, stderr);
  const res2 = await send(makeBody("cache-2"));
  assert.equal(res2.status, 200, stderr);

  const boardListCalls = gatewayCalls.filter((call) => call.operation === "board_lists");
  assert.equal(
    boardListCalls.length,
    2,
    `expected board_lists to be refetched per request with TTL=0, got ${boardListCalls.length}`,
  );
});
