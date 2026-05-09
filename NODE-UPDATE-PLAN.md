# Node runtime update plan

Context: the running OpenClaw host was observed on Node `v24.14.0`; Node `v24.15.0` is the target patch release called out in the Trello planning card.

This repository should not directly upgrade the host runtime from CI. The safe change is to keep the deployment repo ready for the update, document the operator runbook, and leave the actual host/runtime mutation approval-gated.

## Scope

- Applies to the host-managed Node runtime used for local/OpenClaw CLI scripts and maintenance tasks.
- Does not change the published OpenClaw container image pin.
- Does not rotate secrets, restart production services, or mutate the droplet by itself.

## Preflight checklist

1. Confirm the current runtime and package health:

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

## Update procedure (approval-gated)

Only run this after Adriel explicitly approves the host/runtime change and the restart window.

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

## Rollback plan

If validation or service health fails:

1. Reinstall the previously captured Node version using the same install source.
2. Restart the affected services.
3. Re-run the verification commands above.
4. Record the failed target version, failing command output, and rollback result on the Trello card before retrying.

## PR intent

This PR intentionally adds planning documentation only. It creates a reviewable artifact for the Node patch plan without performing the irreversible runtime update.
