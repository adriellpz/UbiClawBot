# Context Glossary

## Terms

- **Agent workspace**: the OpenClaw working repository that holds agent memory, hooks, persona files, experiments, manual helpers, and other workspace-specific runtime concerns.
- **Trello production pipeline**: the production code path that receives Trello events, classifies them, queues unattended work, runs Trello/calendar automation, and applies resulting Trello/calendar changes.
- **Scheduled Trello/calendar job**: an unattended Trello/calendar automation job triggered by time or cron rather than by an incoming webhook event.
- **Pipeline state**: durable operational state used by the Trello production pipeline, such as queue records, handled-action tracking, retry tracking, and similar service state. This is distinct from agent memory or taskflow state.
- **Documentation contract test**: a `node:test` case in `UbiClawBot` that asserts a structural or cross-repo documentation invariant (for example, a forbidden duplicate path is absent or a required canonical page exists). These tests may read sibling agent repositories; they are not tests of runtime Trello behavior.
