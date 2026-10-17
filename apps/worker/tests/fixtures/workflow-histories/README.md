# Temporal Workflow Replay History Fixtures

This directory contains synthetic Temporal workflow execution histories (`*.json`) used by `apps/worker/tests/temporal-workflow-replay.test.ts` to gate workflow replay determinism in CI via `Worker.runReplayHistories`.

## Recorded fixtures

- `dot-goal-workflow.json` — `dotGoalWorkflow` (`apps/worker/src/workflows.ts`)
- `dummy-turn-workflow.json` — `dummyTurnWorkflow` (`apps/worker/src/workflows.ts`)
- `codex-app-server-turn-workflow.json` — `codexAppServerTurnWorkflow` (`apps/worker/src/workflows.ts`)
- `room-agent-action-workflow.json` — `roomAgentActionWorkflow` (`apps/worker/src/workflows.ts`)
- `room-agent-supervisor-workflow.json` — `roomAgentSupervisorWorkflow` current branch (`apps/worker/src/workflows.ts`)
- `room-agent-supervisor-pre-patch.json` — `roomAgentSupervisorWorkflow` pre-patch branch (`!patched("room-background-continuation-v1")`)
- `memory-maintenance-workflow.json` — `memoryMaintenanceWorkflow` (`apps/worker/src/memory-maintenance-workflows.ts`)
- `memory-consolidation-workflow.json` — `memoryConsolidationWorkflow` (`apps/worker/src/memory-maintenance-workflows.ts`)
- `memory-mutation-workflow.json` — `memoryMutationWorkflow` (`apps/worker/src/memory-mutation-workflows.ts`)

## When and how to re-record histories

**Never re-record workflow histories just to make a failing replay test pass.** A `DeterminismViolationError` during replay means a workflow change would break in-flight executions on a live Temporal cluster.

1. Gate any incompatible control-flow, timer, activity, or child-workflow change in a Temporal workflow behind `patched("<patch-id>")` (from `@temporalio/workflow`) so existing histories continue to replay down the pre-patch branch.
2. Keep pre-patch history fixtures intact so CI continues to verify the legacy branch alongside the new branch.
3. Only record or update synthetic history fixtures when adding a new workflow or recording an additional fixture for a newly introduced `patched()` branch:

```sh
npm run temporal:record-histories -w @space/worker
```

Then run the worker test suite to verify both time-skipping execution and replay determinism:

```sh
npm test -w @space/worker
```
