# OpenClaw A2A local patch notes — 2026-05-11

This repository does not vendor OpenClaw. These notes document local runtime patches applied to the OpenClaw installation that runs Ubi/Cheryl/Marcos, so the behavior is recoverable after an OpenClaw update or rebuild.

## Environment

- Installed OpenClaw version observed: `2026.4.23`
- Runtime files patched under `/app/dist`
- Gateway target seen in failures: `ws://127.0.0.1:18789`
- Affected workflow: `sessions_send` between agents in the same OpenClaw instance (`main`, `scheduler`, `marcos`)

## Symptoms

Two related A2A issues were observed:

1. `sessions_send(..., timeoutSeconds > 0)` could return a gateway timeout or `gateway closed (1000 normal closure)` even though the target agent received the message and answered.
2. After a waited `sessions_send` successfully returned the target reply inline, OpenClaw still injected a second `Agent-to-agent announce step.` turn into the target session, causing duplicate/noisy replies.

Representative errors:

```text
gateway closed (1000 normal closure): no close reason
Gateway target: ws://127.0.0.1:18789
Source: local loopback
Config: /home/node/.openclaw/openclaw.json
Bind: loopback
```

```text
gateway timeout after 12000ms
```

## Local patches applied

### 1. `agent.wait` fallback for active main/chat runs

Patched file:

```text
/app/dist/server-plugin-bootstrap-CxnqPNN-.js
```

Backup:

```text
/app/dist/server-plugin-bootstrap-CxnqPNN-.js.bak-20260511-a2a-agentwait
```

Observed bug shape:

- `sessions_send` injects the target message successfully.
- It then waits through `agent.wait` / `waitForAgentRunAndReadUpdatedAssistantReply`.
- For active main/chat runs, the wait path ignores `agent:<runId>` terminal snapshots.
- Internal A2A sends can complete and write the `agent:<runId>` terminal record while the chat completion record is missing/late/unreliable.
- Result: false timeout even though the target reply exists in session history.

Patch behavior:

- When `agent.wait` is about to timeout for an active main/chat run, do a final fallback read that does **not** ignore the `agent:<runId>` terminal snapshot.
- If that terminal snapshot is `ok`, `error`, or `timeout`, return it instead of reporting a false timeout.

Verification after gateway restart:

- Ubi → Cheryl returned `status: ok`, reply `PATCH_WAIT_OK_CHERYL`.
- Ubi → Marcos returned `status: ok`, reply `PATCH_WAIT_OK_MARCOS`.

### 2. Skip A2A announce step after waited sends

Patched file:

```text
/app/dist/openclaw-tools-QGieR8bq.js
```

Backup:

```text
/app/dist/openclaw-tools-QGieR8bq.js.bak-20260511-a2a-announce-skip-wait
```

Patch behavior:

- If `timeoutSeconds > 0`, skip the follow-up A2A announce step because the caller already waited for and received the inline reply.
- Preserve announce behavior for fire-and-forget sends with `timeoutSeconds: 0`.

Verification after gateway restart:

- Ubi → Cheryl returned `status: ok`, reply `NO_ANNOUNCE_OK_CHERYL`, `delivery.status: skipped`.
- Ubi → Marcos returned `status: ok`, reply `NO_ANNOUNCE_OK_MARCOS`, `delivery.status: skipped`.
- Target histories showed no new `Agent-to-agent announce step.` after the patch.

## Remaining caveat

Reverse A2A (`scheduler`/`marcos` → `main`) still needs separate treatment. Initial reverse tests using waited sends toward `agent:main:main` timed out at the gateway wait layer, and `label: main` did not resolve. That appears to be a distinct routing/wait/inbox issue from the forward wait-path and duplicate-announce bugs fixed above.

## Operational warning

These are local `/app/dist` patches, not durable source changes. An OpenClaw update, image rebuild, package reinstall, or dist refresh may overwrite them. Before updating OpenClaw, preserve this note and expect to re-test:

- Ubi → Cheryl waited `sessions_send`
- Ubi → Marcos waited `sessions_send`
- absence of duplicate `Agent-to-agent announce step.`
- Cheryl/Marcos → Ubi reverse A2A
