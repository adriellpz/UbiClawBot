# ADR-0008: Self-Hosted Browserless for HITL Browser Handoffs

Browserbase (the previous HITL browser provider) was rejected due to cost, free-tier exhaustion, and low screencast resolution. We evaluated three alternatives and chose self-hosted Browserless (`browserless/chrome`) running in Docker on the droplet, exposed via Cloudflare Tunnel.

## Considered Options

- **Approach A: Self-hosted Browserless (Docker)** — same `liveURL` API as Browserbase, drop-in replacement, free, 1080p screencast configurable via CDP. Chosen.
- **Approach B: Chrome + Cloudflare Tunnel + DevTools Frontend** — faster MVP but DevTools UI is too complex for daily HITL use, and no built-in `liveComplete` event.
- **Approach C: Custom CDP WebSocket bridge + canvas page** — maximum UX control, but days of custom development with no prior art.

## Decision

Browserless runs as a Docker service on the droplet. A Cloudflare Tunnel exposes it under a dedicated subdomain. A static `TOKEN` env var authenticates connections (per-session tokens require a custom proxy layer — deferred). The `browserbase` browser profile in `openclaw.json` is replaced by a `hitl` profile pointing at the local Browserless WebSocket endpoint.

All agents share one persistent `--user-data-dir` on the droplet so login state survives between sessions. Concurrent sessions are enabled. Screencast resolution is 1080p via CDP `Page.startScreencast` `maxWidth`/`maxHeight`. The `ubi-dev-safety` guard against using browser tools without explicit permission is removed — Ubi auto-triggers HITL whenever she hits a bot check.

## Consequences

- Ubi sends a numbered Telegram message per session ("HITL #1: Stripe / Senior Engineer → [url]") when a bot check is hit.
- Session completion is detected by DOM polling first; if the expected condition doesn't resolve, Ubi sends a Telegram follow-up and waits for an "N done" reply.
- Inline Telegram buttons (per-session "Mark done") are post-MVP — text replies are the fallback for now.
- Per-session token rotation requires a thin auth proxy in front of Browserless; deferred until the static token posture becomes a concern.
