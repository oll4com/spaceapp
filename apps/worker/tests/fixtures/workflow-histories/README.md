# Temporal Workflow History Fixtures

This directory contains synthetic, recorded Temporal workflow execution histories in JSON format.
These fixtures serve as regression baselines to verify replay determinism in CI and prevent accidental non-deterministic changes to live workflows.

## Recorded Fixtures

| Fixture File | Workflow Name | Target File | Description |
|---|---|---|---|
| `dummy-turn.json` | `dummyTurnWorkflow` | `src/workflows.ts` | Turn workflow start and completion recording |
| `codex-app-server-turn.json` | `codexAppServerTurnWorkflow` | `src/workflows.ts` | Codex app server turn execution |
| `dot-goal.json` | `dotGoalWorkflow` | `src/workflows.ts` | Dots goal loop sequencing |
| `room-agent-supervisor-patched.json` | `roomAgentSupervisorWorkflow` | `src/workflows.ts` | Supervisor execution under `patched("room-background-continuation-v1")` with `continueAsNew` |
| `room-agent-supervisor-legacy.json` | `roomAgentSupervisorWorkflow` | `src/workflows.ts` | Legacy supervisor pre-patch execution path with `continueAsNew` |
| `room-agent-action.json` | `roomAgentActionWorkflow` | `src/workflows.ts` | Background action execution |
| `memory-maintenance.json` | `memoryMaintenanceWorkflow` | `src/memory-maintenance-workflows.ts` | Memory maintenance orchestrating child consolidation |
| `memory-consolidation.json` | `memoryConsolidationWorkflow` | `src/memory-maintenance-workflows.ts` | Memory consolidation and repair finalization |
| `memory-mutation.json` | `memoryMutationWorkflow` | `src/memory-mutation-workflows.ts` | Persisted memory change-set execution |

## Replay Verification

These histories are validated during test runs via `@temporalio/worker` replay APIs (`Worker.runReplayHistories` / `Worker.runReplayHistory`).
Any backward-incompatible change to existing workflow command sequences (such as reordering activities, adding unsheltered timers, or changing child workflow parameters without versioning) causes replay to throw `DeterminismViolationError`.

## History Re-Recording Policy

1. **Maintain Replay Compatibility**: Modifying workflow logic that affects history must preserve replay compatibility with previously recorded histories using Temporal's `patched()` API.
2. **When to Re-Record**:
   - When a new workflow is added to the application.
   - When a patch has been phased out via `deprecatePatch()`, and older histories are permanently retired.
   - When an intentional workflow breaking change is approved across version boundaries.
3. **How to Re-Record**:
   Run the recording script from the repository root:
   ```bash
   npm run temporal:record-histories -w @space/worker
   ```
4. **Never Mask Determinism Bugs**: Do **not** re-record fixtures to make a broken replay test pass. If a test fails with `DeterminismViolationError`, the workflow implementation has introduced a non-deterministic regression that must be resolved with `patched()` or code alignment.
