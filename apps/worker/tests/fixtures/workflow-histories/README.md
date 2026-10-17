# Recorded Temporal Workflow Histories

This directory contains synthetic Temporal workflow execution histories replayed in CI by `apps/worker/tests/workflow-replay.test.ts` via `Worker.runReplayHistories`.

## Covered workflows

- `dotGoalWorkflow.json` (`dotGoalWorkflow` in `apps/worker/src/workflows.ts`)
- `dummyTurnWorkflow.json` (`dummyTurnWorkflow` in `apps/worker/src/workflows.ts`)
- `codexAppServerTurnWorkflow.json` (`codexAppServerTurnWorkflow` in `apps/worker/src/workflows.ts`)
- `roomAgentSupervisorWorkflow.json` (`roomAgentSupervisorWorkflow` current branch behind `patched("room-background-continuation-v1")` in `apps/worker/src/workflows.ts`)
- `roomAgentSupervisorWorkflow-pre-patch.json` (`roomAgentSupervisorWorkflow` pre-patch branch behind `!patched("room-background-continuation-v1")` in `apps/worker/src/workflows.ts`)
- `roomAgentActionWorkflow.json` (`roomAgentActionWorkflow` in `apps/worker/src/workflows.ts`, including `patched("room-background-action-failure-v1")`)
- `memoryMaintenanceWorkflow.json` (`memoryMaintenanceWorkflow` in `apps/worker/src/memory-maintenance-workflows.ts`)
- `memoryConsolidationWorkflow.json` (`memoryConsolidationWorkflow` in `apps/worker/src/memory-maintenance-workflows.ts`)
- `memoryMutationWorkflow.json` (`memoryMutationWorkflow` in `apps/worker/src/memory-mutation-workflows.ts`)

## When and how to re-record histories

**Never re-record histories to make a failing replay pass.** A failing replay test means a workflow change would break in-flight executions on existing installations with a `DeterminismViolationError`.

Re-recording (or adding a new history fixture) is allowed **only** when:
1. You introduce a replay-safe branch guarded by `patched("<patch-id>")` (keeping the pre-patch branch and its existing history fixture intact while recording a new history for the patched path), or
2. You add a brand-new workflow type.

To record synthetic histories from the time-skipping test server:

```sh
npm run temporal:record-histories -w @space/worker
```

By default, `writeWorkflowHistoryFixtures` preserves existing fixture files to protect legacy and baseline histories from accidental modification. When introducing a `patched()` gate and intentionally refreshing or replacing existing fixtures, pass `--overwrite`:

```sh
npm run temporal:record-histories -w @space/worker -- --overwrite
```

To add a new history fixture for a new workflow or a patched branch variant, add its entry with a dedicated filename to `EXPECTED_HISTORY_FIXTURES` in `apps/worker/tests/support/workflow-sandbox-harness.ts` so both the legacy and patched fixtures remain tracked and replayed.

