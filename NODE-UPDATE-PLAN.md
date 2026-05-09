# Node runtime and container image plan

Context: the running OpenClaw host was observed on Node `v24.14.0`; Node `v24.15.0` is the target patch release called out in the Trello planning card. This PR also pins the OpenClaw container base image to `ghcr.io/openclaw/openclaw:2026.5.7` so deploys rebuild and recreate services on the intended runtime image.

This document separates two related but different changes:

1. **Container image pin:** tracked in this repository and applied by the deploy workflow.
2. **Host OS Node upgrade:** approval-gated manual operator work for host-managed Node scripts and CLIs.

## Scope

- Pins the OpenClaw container image used by this deploy repo to `ghcr.io/openclaw/openclaw:2026.5.7` in `.env.example`, `workspace/Dockerfile.gog`, and `workspace/docker-compose.droplet.yml`.
- Keeps repository validation aligned with the intended runtime by requiring `package.json` engines `node >=24.15.0` and checking that exact value in `scripts/test-gate.mjs`.
- Documents the separate host OS Node upgrade path for local/OpenClaw CLI scripts and maintenance tasks.
- Does not rotate secrets or directly run a manual host OS Node upgrade from CI.
- Merging to `main` can trigger **Deploy to Droplet** for matching paths. That CI deploy rebuilds `openclaw-with-gog:local` from the pinned container base image and recreates the gateway/CLI/bridge containers. It is distinct from a manual host OS Node package upgrade, which still requires explicit operator approval.

## Container image pin shipped by this PR

This PR pins the deployment to `ghcr.io/openclaw/openclaw:2026.5.7` in:

- `.env.example` (`OPENCLAW_IMAGE`)
- `workspace/Dockerfile.gog` (`ARG BASE_IMAGE` default)
- `workspace/docker-compose.droplet.yml` (`OPENCLAW_IMAGE` fallback)

Deployments that use the tracked defaults rebuild `openclaw-with-gog:local` from the new OpenClaw base image and recreate the gateway, CLI, Trello bridge, and GitHub PR bridge containers on that image. If the droplet has an older persisted `.env` override for `OPENCLAW_IMAGE`, update that value to `ghcr.io/openclaw/openclaw:2026.5.7` before rebuilding.

Post-deploy verification:

```bash
docker compose ps
docker compose exec openclaw-gateway node --version
openclaw gateway status
npm test
```

## Host OS Node runbook

The host OS Node runtime is separate from the OpenClaw container base image. This repo should not directly upgrade the host runtime from CI. Use the following runbook only after Adriel explicitly approves the host/runtime change and the restart window.

### Preflight checklist

1. Confirm the current host runtime and package health:

   ```bash
   node --version
   npm --version
   npm audit --omit=dev
   ```

2. Confirm deploy repo validation passes:

   ```bash
   npm test
   ```

3. Capture rollback details before changing anything:
   - current `node --version`
   - current install source (`which node`, package manager, `nvm`, or container image)
   - current service status (`openclaw gateway status` if available)

### Update procedure, approval-gated

1. Install the target Node patch using the host's existing installation method.
2. Restart only the services that depend on the host Node runtime.
3. Verify:

   ```bash
   node --version
   npm --version
   npm test
   openclaw gateway status
   ```

4. Watch Trello/GitHub webhook intake for at least one successful poll cycle.

### Rollback plan

If validation or service health fails:

1. Reinstall the previously captured Node version using the same install source.
2. Restart the affected services.
3. Re-run the verification commands above.
4. Record the failed target version, failing command output, and rollback result on the Trello card before retrying.

## PR intent

This PR intentionally ships the repository-side runtime alignment only: container image pinning, deploy documentation alignment, engine/test-gate checks, and the host OS Node runbook. It does not perform the manual host OS Node package upgrade itself.
