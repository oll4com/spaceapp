# Temporal Workflow Replay History Fixtures

These synthetic JSON histories are replayed in CI via `Worker.runReplayHistories` (`apps/worker/tests/workflow-replay-determinism.test.ts`) to guarantee that workflow changes remain replay-compatible with running executions.

## Re-recording histories

```sh
npm run temporal:record-histories -w @space/worker
```

**Policy:** Re-recording histories is allowed **only** when adding a new workflow or introducing a replay-safe `patched("<patch-id>")` branch alongside both pre-patch and post-patch fixtures. Never re-record histories to make a failing determinism check pass.
