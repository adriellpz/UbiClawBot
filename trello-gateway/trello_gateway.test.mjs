import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";

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
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await once(child, "exit");
}

async function waitFor(url, { timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function getJsonBody(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : {};
}

function createStubTrelloServer() {
  const boardId = "board-test";
  const lists = [
    { id: "list-backlog", name: "Backlog", closed: false },
    { id: "list-scheduled", name: "Scheduled", closed: false },
    { id: "list-done", name: "Done", closed: false },
    { id: "list-review", name: "Review", closed: false },
  ];
  const cards = new Map();
  const checklistsByCard = new Map();
  const callLog = [];
  let checklistCounter = 0;

  function ensureChecklists(cardId) {
    if (!checklistsByCard.has(cardId)) checklistsByCard.set(cardId, []);
    return checklistsByCard.get(cardId);
  }

  function addCard(card) {
    cards.set(card.id, { ...card });
    ensureChecklists(card.id);
  }

  function setChecklists(cardId, checklists) {
    checklistsByCard.set(cardId, checklists.map((checklist) => ({ ...checklist })));
  }

  addCard({
    id: "card-compliant",
    name: "Compliant card",
    idList: "list-backlog",
    closed: false,
    shortUrl: "card-compliant",
    desc: [
      "Original Request:",
      "Ship the Trello contract.",
      "",
      "Research:",
      "Reviewed the gateway boundary and contract rules.",
      "",
      "Peer Review:",
      "",
      "Work completed:",
      "2026-05-25 MDT - Locked the validator scope.",
    ].join("\n"),
  });
  setChecklists("card-compliant", [{ id: "chk-next", name: "Next steps" }]);

  addCard({
    id: "card-drifted",
    name: "Drifted card",
    idList: "list-backlog",
    closed: false,
    shortUrl: "card-drifted",
    desc: [
      "Original Request:",
      "Ship the Trello contract.",
      "",
      "Research:",
      "Legacy body still has the wrong section.",
      "",
      "Next steps:",
      "Still in the description.",
      "",
      "Work completed:",
      "not dated",
    ].join("\n"),
  });
  setChecklists("card-drifted", []);

  addCard({
    id: "card-missing-checklist",
    name: "Checklist repair card",
    idList: "list-backlog",
    closed: false,
    shortUrl: "card-missing-checklist",
    desc: [
      "Original Request:",
      "Repair the checklist contract.",
      "",
      "Research:",
      "The card body is already compliant.",
      "",
      "Peer Review:",
      "",
      "Work completed:",
      "",
    ].join("\n"),
  });
  setChecklists("card-missing-checklist", []);

  addCard({
    id: "card-drifted-body-only",
    name: "Drifted body only card",
    idList: "list-backlog",
    closed: false,
    shortUrl: "card-drifted-body-only",
    desc: [
      "Original Request:",
      "Ship the Trello contract.",
      "",
      "Research:",
      "Legacy body still has the wrong section.",
      "",
      "Next steps:",
      "Still in the description.",
      "",
      "Work completed:",
      "not dated",
    ].join("\n"),
  });
  setChecklists("card-drifted-body-only", [{ id: "chk-next-body-only", name: "Next steps" }]);

  addCard({
    id: "card-empty-intake",
    name: "Empty intake card",
    idList: "list-backlog",
    closed: false,
    shortUrl: "card-empty-intake",
    desc: "",
  });
  setChecklists("card-empty-intake", []);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const path = url.pathname;
    callLog.push({ method: req.method, path, search: url.searchParams.toString() });
    const params = Object.fromEntries(url.searchParams.entries());

    const send = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(payload === null ? "" : JSON.stringify(payload));
    };

    if (req.method === "GET" && path === `/1/boards/${boardId}/lists`) {
      send(200, lists);
      return;
    }

    if (req.method === "GET" && path.startsWith("/1/cards/") && path.endsWith("/checklists")) {
      const cardId = path.split("/")[3];
      send(200, ensureChecklists(cardId));
      return;
    }

    if (req.method === "GET" && path.startsWith("/1/cards/")) {
      const cardId = path.split("/")[3];
      send(200, cards.get(cardId));
      return;
    }

    if (req.method === "POST" && path === "/1/cards") {
      const body = { ...params, ...(await getJsonBody(req)) };
      const cardId = `card-created-${cards.size + 1}`;
      const card = {
        id: cardId,
        name: body.name,
        idList: body.idList,
        closed: false,
        shortUrl: cardId,
        desc: body.desc || "",
      };
      cards.set(cardId, card);
      ensureChecklists(cardId);
      send(200, card);
      return;
    }

    if (req.method === "PUT" && path.startsWith("/1/cards/")) {
      const cardId = path.split("/")[3];
      const body = { ...params, ...(await getJsonBody(req)) };
      const card = cards.get(cardId);
      Object.assign(card, body);
      send(200, card);
      return;
    }

    if (req.method === "POST" && path.startsWith("/1/cards/") && path.endsWith("/actions/comments")) {
      send(200, { ok: true });
      return;
    }

    if (req.method === "POST" && path.startsWith("/1/cards/") && path.endsWith("/checklists")) {
      const cardId = path.split("/")[3];
      const checklistId = `checklist-${++checklistCounter}`;
      const body = { ...params, ...(await getJsonBody(req)) };
      const checklist = { id: checklistId, name: body.name || "Untitled checklist" };
      ensureChecklists(cardId).push(checklist);
      send(200, checklist);
      return;
    }

    if (req.method === "PUT" && path.startsWith("/1/checklists/")) {
      const checklistId = path.split("/")[3];
      const body = { ...params, ...(await getJsonBody(req)) };
      for (const checklists of checklistsByCard.values()) {
        const checklist = checklists.find((entry) => entry.id === checklistId);
        if (checklist) {
          Object.assign(checklist, body);
          send(200, checklist);
          return;
        }
      }
      send(404, { error: "Checklist not found" });
      return;
    }

    if (req.method === "POST" && path.startsWith("/1/checklists/") && path.endsWith("/checkItems")) {
      send(200, { id: `item-${Date.now()}`, ...params, ...(await getJsonBody(req)) });
      return;
    }

    if (req.method === "DELETE" && path.startsWith("/1/checklists/")) {
      const checklistId = path.split("/")[3];
      for (const [cardId, checklists] of checklistsByCard.entries()) {
        const nextChecklists = checklists.filter((entry) => entry.id !== checklistId);
        if (nextChecklists.length !== checklists.length) {
          checklistsByCard.set(cardId, nextChecklists);
          send(200, { deleted: true });
          return;
        }
      }
      send(404, { error: "Checklist not found" });
      return;
    }

    send(404, { error: `Unhandled ${req.method} ${path}` });
  });

  return {
    boardId,
    callLog,
    server,
    getCard(cardId) {
      return cards.get(cardId);
    },
    getChecklists(cardId) {
      return ensureChecklists(cardId);
    },
  };
}

async function startGateway(trelloUrl, boardId) {
  let stdout = "";
  let stderr = "";
  const port = 19092;
  const child = spawn(process.execPath, ["trello_gateway.mjs"], {
    cwd: new URL("./", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      BIND: "127.0.0.1",
      GATEWAY_KEY: "gw-test",
      TRELLO_API_KEY: "trello-key",
      TRELLO_API_TOKEN: "trello-token",
      TRELLO_BOARD_ID: boardId,
      TRELLO_API_BASE_URL: `${trelloUrl}/1`,
      DISABLE_OVERDUE_CHECKS: "true",
      GATEWAY_LOG: "/tmp/trello-gateway-test.log",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  await waitFor(`http://127.0.0.1:${port}/healthz`);

  return {
    child,
    port,
    getOutput() {
      return { stdout, stderr };
    },
  };
}

async function gatewayRequest(port, body) {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: {
      authorization: "Bearer gw-test",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return {
    status: response.status,
    json: await response.json(),
  };
}

test("create_card enforces a compliant body and creates the native Next steps checklist", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "create_card",
    params: {
      listName: "Backlog",
      name: "Create compliant card",
      desc: [
        "Original Request:",
        "Create a compliant card.",
        "",
        "Research:",
        "The gateway should enforce the contract at creation time.",
        "",
        "Peer Review:",
        "",
        "Work completed:",
        "",
      ].join("\n"),
      checklists: [{ name: "Next steps" }],
    },
  });

  assert.equal(response.status, 200, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.success, true);
  assert.equal(trello.getChecklists(response.json.cardId)[0]?.name, "Next steps");
});

test("create_card rejects cards that prefill Peer Review content", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "create_card",
    params: {
      listName: "Backlog",
      name: "Create invalid card",
      desc: [
        "Original Request:",
        "Create a noncompliant card.",
        "",
        "Research:",
        "The gateway should block prefilled peer review content.",
        "",
        "Peer Review:",
        "Already approved.",
        "",
        "Work completed:",
        "",
      ].join("\n"),
      checklists: [{ name: "Next steps" }],
    },
  });

  assert.equal(response.status, 403, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.blocked, true);
  assert.match(response.json.reason, /Peer Review/);
});

test("update rejects structural writes that violate Original Request immutability", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "update",
    cardId: "card-compliant",
    params: {
      fields: {
        desc: trello
          .getCard("card-compliant")
          .desc.replace("Ship the Trello contract.", "Replace the whole request."),
      },
    },
  });

  assert.equal(response.status, 403, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.blocked, true);
  assert.match(response.json.reason, /Original Request/);
});

test("update allows compliant structural rewrites to Research", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "update",
    cardId: "card-compliant",
    params: {
      fields: {
        desc: trello
          .getCard("card-compliant")
          .desc.replace(
            "Reviewed the gateway boundary and contract rules.",
            "Updated the research after validating the live enforcement boundary.",
          ),
      },
    },
  });

  assert.equal(response.status, 200, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.updated, true);
});

test("comment still succeeds on a drifted card", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "comment",
    cardId: "card-drifted",
    params: {
      text: "Still discussing repair strategy.",
    },
  });

  assert.equal(response.status, 200, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.commented, true);
});

test("move blocks structural non-repair writes on a drifted card", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "move",
    cardId: "card-drifted",
    params: {
      targetList: "Scheduled",
    },
  });

  assert.equal(response.status, 403, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.blocked, true);
  assert.match(response.json.reason, /repair/i);
});

test("create_checklist can repair a compliant body that is only missing Next steps", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "create_checklist",
    cardId: "card-missing-checklist",
    params: {
      name: "Next steps",
    },
  });

  assert.equal(response.status, 200, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.success, true);
  assert.equal(trello.getChecklists("card-missing-checklist")[0]?.name, "Next steps");
});

test("update can repair a drifted card by replacing the body with a compliant description", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "update",
    cardId: "card-drifted-body-only",
    params: {
      fields: {
        desc: [
          "Original Request:",
          "Ship the Trello contract.",
          "",
          "Research:",
          "Repaired the legacy description shape at the gateway boundary.",
          "",
          "Peer Review:",
          "",
          "Work completed:",
          "",
        ].join("\n"),
      },
    },
  });

  assert.equal(response.status, 200, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.updated, true);
});

test("update allows description-only repair on an empty intake card missing Next steps", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "update",
    cardId: "card-empty-intake",
    params: {
      fields: {
        desc: [
          "Original Request:",
          "Review PR #30.",
          "",
          "Research:",
          "",
          "",
          "Peer Review:",
          "",
          "Work completed:",
          "",
        ].join("\n"),
      },
    },
  });

  assert.equal(response.status, 200, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.updated, true);
});

test("create_checklist allows Next steps repair on an empty intake card missing sections", async (t) => {
  const trello = createStubTrelloServer();
  const trelloListener = await listen(trello.server);
  const gateway = await startGateway(trelloListener.url, trello.boardId);

  t.after(async () => {
    await Promise.allSettled([stopChild(gateway.child), closeServer(trelloListener.server)]);
  });

  const response = await gatewayRequest(gateway.port, {
    agentId: "main",
    operation: "create_checklist",
    cardId: "card-empty-intake",
    params: {
      name: "Next steps",
    },
  });

  assert.equal(response.status, 200, JSON.stringify({ response, output: gateway.getOutput() }, null, 2));
  assert.equal(response.json.success, true);
  assert.equal(trello.getChecklists("card-empty-intake")[0]?.name, "Next steps");
});
