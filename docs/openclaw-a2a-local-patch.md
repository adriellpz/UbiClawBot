# OpenClaw A2A local patch notes — 2026-05-11

This repository does not vendor OpenClaw. These notes document local runtime patches applied to the OpenClaw installation that runs Ubi/Cheryl/Marcos, so the behavior is recoverable after an OpenClaw update or rebuild.

## Environment

- Installed OpenClaw version observed: `2026.4.23`
- Runtime files patched under `/app/dist`
- Gateway target seen in failures: `ws://127.0.0.1:18789`
- Affected workflow: `sessions_send` between agents in the same OpenClaw instance (`main`, `scheduler`, `marcos`)

## Symptoms

Three related A2A issues were observed:

1. `sessions_send(..., timeoutSeconds > 0)` could return a gateway timeout or `gateway closed (1000 normal closure)` even though the target agent received the message and answered.
2. After a waited `sessions_send` successfully returned the target reply inline, OpenClaw still injected a second `Agent-to-agent announce step.` turn into the target session, causing duplicate/noisy replies.
3. Reverse worker → coordinator sends (`scheduler`/`marcos` → `main`) failed when workers targeted `main` / `agent:main:main`, because that resolves to the active main lane instead of a safe coordinator inbox. Direct delivery to Ubi’s Adriel-facing inbox (`agent:main:telegram:default:direct:8045915111`) worked.

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

### 3. Reverse A2A main-inbox routing + announce suppression

Patched file:

```text
/app/dist/openclaw-tools-QGieR8bq.js
```

Backup:

```text
/app/dist/openclaw-tools-QGieR8bq.js.bak-20260511-reverse-a2a-main-inbox
```

Observed bug shape:

- Worker instructions naturally target Ubi as `main` or `agent:main:main`.
- In this deployment, `agent:main:main` is the active coordinator lane and may already be running the turn that requested the worker action.
- Sending reverse A2A into that active lane can timeout or wedge, even with `timeoutSeconds: 0`.
- Sending to Ubi’s concrete Adriel-facing inbox key works: `agent:main:telegram:default:direct:8045915111`.

Patch behavior:

- In `sessions_send`, when a non-`main` requester targets `main` / `agent:main:main`, look up a concrete main-agent direct inbox from `sessions.list` and reroute the send there.
- Prefer the Telegram direct Ubi inbox when present.
- Also skip the A2A announce/ping-pong flow for all `sessions_send` calls, including fire-and-forget sends, to prevent `Agent-to-agent announce step.` debris.

Verification before gateway restart:

- Direct worker → Ubi inbox tests succeeded from both Cheryl and Marcos:
  - `CHERYL_REVERSE_FIXED_OK`
  - `MARCOS_REVERSE_FIXED_OK`
- `node --check /app/dist/openclaw-tools-QGieR8bq.js` passed.

Verification after gateway restart:

- Cheryl → `main` alias landed in Ubi’s concrete inbox: `CHERYL_REVERSE_ALIAS_MAIN_OK`.
- Marcos → `main` alias landed in Ubi’s concrete inbox: `MARCOS_REVERSE_ALIAS_MAIN_OK`.
- No new `Agent-to-agent announce step.` should appear for fire-and-forget reverse sends.

### 4. `sessions_send` late-reply fallback after gateway wait close/timeout

Patched files:

```text
/app/dist/run-wait-1pE_J14t.js
/app/dist/openclaw-tools-QGieR8bq.js
```

Backups:

```text
/app/dist/run-wait-1pE_J14t.js.bak-20260511-read-reply-after-wait-timeout
/app/dist/openclaw-tools-QGieR8bq.js.bak-20260511-sessions-send-late-reply-fallback
```

Observed bug shape:

- A waited `sessions_send(... timeoutSeconds > 0)` can report `gateway closed (1000 normal closure)` or timeout even though the target session received the message and wrote a new assistant reply almost immediately.
- Evidence: Marcos/Cheryl histories contained the exact requested replies while the caller saw a gateway close/timeout error.
- The fragile point is the wait/reporting path, not delivery.

Patch behavior:

- `run-wait`: after `agent.wait`, read target session history against the pre-send baseline; if a new assistant reply exists, return `ok` even if `agent.wait` reported timeout/error.
- `sessions_send`: added a direct late-reply fallback around timeout/error handling that polls target history briefly before returning an error.

Verification after gateway restart:

- Marcos waited send returned `status: ok`, reply `MARCOS_WAIT_DIRECT_OK`.
- Cheryl waited send returned `status: ok`, reply `CHERYL_WAIT_SOLO_OK`.
- Parallel waited sends returned `status: ok` for both:
  - `MARCOS_PARALLEL_WAIT_OK`
  - `CHERYL_PARALLEL_WAIT_OK`

## Operational warning

These are local `/app/dist` patches, not durable source changes. An OpenClaw update, image rebuild, package reinstall, or dist refresh may overwrite them. Before updating OpenClaw, preserve this note and expect to re-test:

- Ubi → Cheryl waited `sessions_send`
- Ubi → Marcos waited `sessions_send`
- absence of duplicate `Agent-to-agent announce step.`
- Cheryl/Marcos → Ubi reverse A2A
