# Temporal Workflow Replay Histories

This directory contains synthetic Temporal workflow execution histories (`*.json`) used by `apps/worker/tests/temporal-workflow-replay.test.ts` to gate workflow replay determinism in CI.

## Covered Workflows

- `dotGoalWorkflow.json` (`apps/worker/src/workflows.ts`)
- `dummyTurnWorkflow.json` (`apps/worker/src/workflows.ts`)
- `codexAppServerTurnWorkflow.json` (`apps/worker/src/workflows.ts`)
- `roomAgentSupervisorWorkflow.json` (`apps/worker/src/workflows.ts` — current `patched("room-background-continuation-v1")` branch)
- `roomAgentSupervisorWorkflow.pre-patch.json` (`apps/worker/src/workflows.ts` — pre-patch legacy supervisor branch)
- `roomAgentActionWorkflow.json` (`apps/worker/src/workflows.ts` — `patched("room-background-action-failure-v1")` failure path)
- `memoryMaintenanceWorkflow.json` (`apps/worker/src/memory-maintenance-workflows.ts`)
- `memoryConsolidationWorkflow.json` (`apps/worker/src/memory-maintenance-workflows.ts`)
- `memoryMutationWorkflow.json` (`apps/worker/src/memory-mutation-workflows.ts`)

## How to Re-record Histories

From the repository root, run:

```sh
# Record only missing fixtures (existing files are skipped by default):
npm run temporal:record-histories -w @space/worker

# Overwrite specific or all fixtures explicitly (after renaming/retaining pre-patch fixtures):
npm run temporal:record-histories -w @space/worker -- --force [workflowFixtureName]
```

All fixtures are generated locally against `@temporalio/testing`'s time-skipping server using synthetic inputs and stubbed activities (no external database, Docker, or AI provider required). Note that `TestWorkflowEnvironment.createTimeSkipping()` downloads and caches the Temporal test-server binary on first use unless a pre-downloaded binary is supplied via `server.executable`.

## When Re-recording Is Allowed

- **Allowed**: Only together with a replay-safe [`patched()`](https://docs.temporal.io/develop/typescript/versioning#patching) workflow change (or when adding a brand-new workflow type), while keeping pre-patch history fixtures so both old and new branches remain replay-verified.
- **Forbidden**: **Never** re-record history fixtures to make a failing replay test pass. If `Worker.runReplayHistories` fails with `DeterminismViolationError`, the workflow change would break in-flight executions on existing installations and must be gated behind `patched()`.
