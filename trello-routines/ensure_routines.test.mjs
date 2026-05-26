import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function runScript(args, { cwd, env = {} }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(process.execPath, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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

function createGatewayStub({ boardOpenCards = [] } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body || "{}");
    calls.push(parsed);

    res.writeHead(200, { "content-type": "application/json" });
    if (parsed.operation === "create_card") {
      res.end(JSON.stringify({ cardId: "card-created-1", url: "https://trello.com/c/card-created-1" }));
      return;
    }
    if (parsed.operation === "comment") {
      res.end(JSON.stringify({ commented: true }));
      return;
    }
    if (parsed.operation === "get") {
      res.end(
        JSON.stringify({
          card: {
            id: parsed.cardId,
            name: "R - Dog walk - 2026-05-27",
            shortUrl: "https://trello.com/c/card-created-1",
            labels: [],
            idMembers: [],
            list: { name: "Routine" },
          },
        }),
      );
      return;
    }
    if (parsed.operation === "board_open_cards") {
      res.end(JSON.stringify({ cards: boardOpenCards }));
      return;
    }
    if (parsed.operation === "set_cover" || parsed.operation === "get_labels" || parsed.operation === "add_label") {
      res.end(JSON.stringify({ ok: true, labels: [] }));
      return;
    }
    if (parsed.operation === "add_member" || parsed.operation === "remove_member") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });

  return { server, calls };
}

function createGogStub(tempDir, { events = [] } = {}) {
  const logPath = path.join(tempDir, "gog-calls.jsonl");
  const scriptPath = path.join(tempDir, "gog");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
import fs from "node:fs";

const logPath = process.env.GOG_STUB_LOG_PATH;
const args = process.argv.slice(2);
fs.appendFileSync(logPath, JSON.stringify({ args }) + "\\n");

if (args[0] === "calendar" && args[1] === "create") {
  process.stdout.write(JSON.stringify({
    event: { htmlLink: "https://www.google.com/calendar/event?eid=routine-123" },
  }));
  process.exit(0);
}

if (args[0] === "calendar" && args[1] === "events") {
  process.stdout.write(JSON.stringify(${JSON.stringify({ events })}));
  process.exit(0);
}

process.stdout.write(JSON.stringify({ ok: true }));
`,
    { mode: 0o755 },
  );

  return { scriptPath, logPath };
}

test("dry-run routines script reports a shifted slot around a personal event", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    eventsPath,
    JSON.stringify(
      [
        {
          summary: "Dentist",
          start: { dateTime: "2026-05-27T10:00:00-06:00" },
          end: { dateTime: "2026-05-27T10:20:00-06:00" },
        },
      ],
      null,
      2,
    ),
  );

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
      "--dry-run",
    ],
    { cwd: REPO_ROOT },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0].title, "R - Dog walk - 2026-05-27");
  assert.equal(report.created[0].shifted, true);
});

test("dry-run routines script reports manual follow-up when no clean slot exists", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    eventsPath,
    JSON.stringify(
      [
        {
          summary: "Dentist",
          start: { dateTime: "2026-05-27T10:15:00-06:00" },
          end: { dateTime: "2026-05-27T10:45:00-06:00" },
        },
      ],
      null,
      2,
    ),
  );

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
      "--dry-run",
    ],
    { cwd: REPO_ROOT },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0].manualScheduling, true);
  assert.equal(report.created[0].reason, "no_open_slot_in_prefer_window");
  assert.equal(report.skipped.length, 0);
});

test("dry-run routines script keeps the preferred slot for claimable Trello overlap", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");
  const openCardsPath = path.join(tempDir, "open-cards.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    eventsPath,
    JSON.stringify(
      [
        {
          summary: "Existing task",
          description: "Trello: https://trello.com/c/Claim123",
          start: { dateTime: "2026-05-27T10:00:00-06:00" },
          end: { dateTime: "2026-05-27T10:30:00-06:00" },
        },
      ],
      null,
      2,
    ),
  );

  fs.writeFileSync(
    openCardsPath,
    JSON.stringify(
      [
        {
          id: "card-1",
          name: "P2 - Existing task",
          listName: "Scheduled",
          shortUrl: "https://trello.com/c/Claim123",
          shortLink: "Claim123",
          desc: "",
        },
      ],
      null,
      2,
    ),
  );

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--open-cards-file",
      openCardsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
      "--dry-run",
    ],
    { cwd: REPO_ROOT },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0].shifted, false);
});

test("non-dry routines script creates a routine card and leaves the system manual-follow-up comment", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    eventsPath,
    JSON.stringify(
      [
        {
          summary: "Dentist",
          start: { dateTime: "2026-05-27T10:15:00-06:00" },
          end: { dateTime: "2026-05-27T10:45:00-06:00" },
        },
      ],
      null,
      2,
    ),
  );

  const gateway = createGatewayStub();
  const listener = await listen(gateway.server);
  t.after(async () => {
    await closeServer(listener.server);
  });

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        TRELLO_GATEWAY_URL: listener.url,
        TRELLO_GATEWAY_KEY: "gw-test",
      },
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const createCall = gateway.calls.find((call) => call.operation === "create_card");
  assert.equal(createCall?.agentId, "system");
  const commentCall = gateway.calls.find((call) => call.operation === "comment");
  assert.equal(commentCall?.agentId, "system");
  assert.match(commentCall?.params?.text || "", /@adriellpz1/);
});

test("non-dry routines script creates a scheduled routine card and calendar event for a clean slot", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");
  const openCardsPath = path.join(tempDir, "open-cards.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(eventsPath, JSON.stringify([], null, 2));
  fs.writeFileSync(openCardsPath, JSON.stringify([], null, 2));

  const gateway = createGatewayStub();
  const listener = await listen(gateway.server);
  const gog = createGogStub(tempDir);
  t.after(async () => {
    await closeServer(listener.server);
  });

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--open-cards-file",
      openCardsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        GOG_BIN: gog.scriptPath,
        GOG_STUB_LOG_PATH: gog.logPath,
        TRELLO_GATEWAY_URL: listener.url,
        TRELLO_GATEWAY_KEY: "gw-test",
      },
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0].manualScheduling, undefined);
  assert.equal(report.created[0].shifted, false);
  assert.equal(report.created[0].cardId, "card-created-1");

  assert.equal(gateway.calls.some((call) => call.operation === "create_card"), true);
  assert.equal(gateway.calls.some((call) => call.operation === "update"), true);
  const updated = gateway.calls.find((call) => call.operation === "update");
  assert.match(updated?.params?.fields?.desc || "", /Calendar time:/);
  assert.match(updated?.params?.fields?.desc || "", /https:\/\/www\.google\.com\/calendar\/event\?eid=routine-123/);

  const gogCalls = fs
    .readFileSync(gog.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(gogCalls[0]?.args?.slice(0, 2), ["calendar", "create"]);
});

test("non-dry routines script displaces claimable Trello overlap after scheduling the routine", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");
  const openCardsPath = path.join(tempDir, "open-cards.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(
    eventsPath,
    JSON.stringify(
      [
        {
          summary: "Existing task",
          description: "Trello: https://trello.com/c/Claim123",
          start: { dateTime: "2026-05-27T10:00:00-06:00" },
          end: { dateTime: "2026-05-27T10:30:00-06:00" },
        },
      ],
      null,
      2,
    ),
  );
  fs.writeFileSync(
    openCardsPath,
    JSON.stringify(
      [
        {
          id: "card-1",
          name: "P2 - Existing task",
          listName: "Scheduled",
          shortUrl: "https://trello.com/c/Claim123",
          shortLink: "Claim123",
          desc: "",
        },
      ],
      null,
      2,
    ),
  );

  const gateway = createGatewayStub();
  const listener = await listen(gateway.server);
  const gog = createGogStub(tempDir);
  t.after(async () => {
    await closeServer(listener.server);
  });

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--open-cards-file",
      openCardsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        GOG_BIN: gog.scriptPath,
        GOG_STUB_LOG_PATH: gog.logPath,
        TRELLO_GATEWAY_URL: listener.url,
        TRELLO_GATEWAY_KEY: "gw-test",
      },
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 1);
  assert.deepEqual(report.created[0].claimLog, [
    { action: "displaced", card: "P2 - Existing task", to: "Reschedule" },
  ]);

  const moveCall = gateway.calls.find((call) => call.operation === "move");
  assert.equal(moveCall?.cardId, "card-1");
  assert.equal(moveCall?.params?.targetList, "Reschedule");
});

test("dry-run routines script skips a routine instance that already exists on the board", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(eventsPath, JSON.stringify([], null, 2));

  const gateway = createGatewayStub({
    boardOpenCards: [
      {
        id: "existing-routine-1",
        name: "R - Dog walk - 2026-05-27",
        listName: "Routine",
        shortUrl: "https://trello.com/c/existing-routine-1",
        shortLink: "existing-routine-1",
        desc: "Original Request:\nR - Dog walk - 2026-05-27\n\nResearch:\nRoutine instance generated from the routine manifest.\nroutine-id: dog_walk\nroutine-period: 2026-05-27\n\nPeer Review:\n\nWork completed:",
      },
    ],
  });
  const listener = await listen(gateway.server);
  t.after(async () => {
    await closeServer(listener.server);
  });

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
      "--dry-run",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        TRELLO_GATEWAY_URL: listener.url,
        TRELLO_GATEWAY_KEY: "gw-test",
      },
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 0);
  assert.equal(gateway.calls.some((call) => call.operation === "board_open_cards"), true);
  assert.equal(gateway.calls.some((call) => call.operation === "create_card"), false);
});

test("dry-run routines script skips an exact-title routine card even when routine tags are missing", async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const eventsPath = path.join(tempDir, "events.json");

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "submit_timesheet",
            title_template: "R - Submit timesheet - {date}",
            trello_list: "Routine",
            duration_minutes: 60,
            recurrence: "weekly",
            days: ["WED"],
            prefer_start: "08:00",
            prefer_end: "10:00",
          },
        ],
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(eventsPath, JSON.stringify([], null, 2));

  const gateway = createGatewayStub({
    boardOpenCards: [
      {
        id: "existing-routine-untagged-1",
        name: "R - Submit timesheet - 2026-05-27",
        listName: "Routine",
        shortUrl: "https://trello.com/c/existing-routine-untagged-1",
        shortLink: "existing-routine-untagged-1",
        desc: "Original Request:\nR - Submit timesheet - 2026-05-27\n\nPeer Review:\n\nWork completed:",
      },
    ],
  });
  const listener = await listen(gateway.server);
  t.after(async () => {
    await closeServer(listener.server);
  });

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--events-file",
      eventsPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
      "--dry-run",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        TRELLO_GATEWAY_URL: listener.url,
        TRELLO_GATEWAY_KEY: "gw-test",
      },
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.equal(report.skipped[0].reason, "existing_open_card");
  assert.equal(report.skipped[0].matchedBy, "exact_title");
  assert.equal(report.skipped[0].cardId, "existing-routine-untagged-1");
  assert.equal(gateway.calls.some((call) => call.operation === "board_open_cards"), true);
  assert.equal(gateway.calls.some((call) => call.operation === "create_card"), false);
  assert.equal(gateway.calls.some((call) => call.operation === "update"), false);
  assert.equal(gateway.calls.some((call) => call.operation === "comment"), false);
});

test("dry-run routines script fetches calendar events from gog when no events file is provided", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "trello-routines-"));
  const manifestPath = path.join(tempDir, "routine_manifest.json");
  const gog = createGogStub(tempDir, {
    events: [
      {
        summary: "Dentist",
        start: { dateTime: "2026-05-27T10:00:00-06:00" },
        end: { dateTime: "2026-05-27T10:20:00-06:00" },
      },
    ],
  });

  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        timezone: "America/Denver",
        routines: [
          {
            id: "dog_walk",
            title_template: "R - Dog walk - {date}",
            trello_list: "Routine",
            duration_minutes: 30,
            recurrence: "daily",
            prefer_start: "10:00",
            prefer_end: "11:00",
          },
        ],
      },
      null,
      2,
    ),
  );

  const result = await runScript(
    [
      "trello-routines/ensure_routines.mjs",
      "--manifest",
      manifestPath,
      "--lookahead-days",
      "1",
      "--today",
      "2026-05-27",
      "--dry-run",
    ],
    {
      cwd: REPO_ROOT,
      env: {
        GOG_BIN: gog.scriptPath,
        GOG_STUB_LOG_PATH: gog.logPath,
      },
    },
  );

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.created.length, 1);
  assert.equal(report.created[0].shifted, true);

  const gogCalls = fs
    .readFileSync(gog.logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.deepEqual(gogCalls[0]?.args?.slice(0, 2), ["calendar", "events"]);
});
