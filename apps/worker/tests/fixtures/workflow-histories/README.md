# Workflow history fixtures

Recorded Temporal workflow histories used by the replay determinism gate
(`apps/worker/tests/temporal-replay.test.ts`). Each file is the full event
history JSON of one workflow execution, recorded on the time-skipping test
server with synthetic data only (no network, DB, or AI involved).

## Fixtures

| File | Workflow | Scenario |
| --- | --- | --- |
| `dot-goal.json` | `dotGoalWorkflow` | WAITING step, wake signal, DONE step |
| `dummy-turn.json` | `dummyTurnWorkflow` | start -> complete |
| `codex-app-server-turn.json` | `codexAppServerTurnWorkflow` | default branch turn |
| `room-agent-supervisor.json` | `roomAgentSupervisorWorkflow` | continuing branch: enqueue -> child turn -> finish COMPLETED (includes the `room-background-continuation-v1` patch marker) |
| `room-agent-supervisor-legacy.json` | `legacyRoomAgentSupervisorWorkflow` | pre-patch branch: 250 boolean-settle polls -> continueAsNew (no patch marker; the replay bundle maps this history to the current dispatcher, which must route it back into the legacy branch) |
| `room-agent-action.json` | `roomAgentActionWorkflow` | action failure -> fail activity -> original error rethrown (includes the `room-background-action-failure-v1` patch marker) |
| `memory-maintenance.json` | `memoryMaintenanceWorkflow` | refresh -> audit -> child `memoryConsolidationWorkflow` |
| `memory-consolidation.json` | `memoryConsolidationWorkflow` | empty change set path |
| `memory-mutation.json` | `memoryMutationWorkflow` | change set passthrough |

## Re-recording

```sh
npm run temporal:record-histories -w @space/worker
```

This runs `tests/record-workflow-histories.test.ts` with `RECORD_HISTORIES=1`
and rewrites all nine files. Without that env var the test file skips
itself, so plain `npm test` never touches the fixtures.

Re-record **only** together with a `patched()` change (or another
intentional workflow-code change), and commit the new fixtures in the same
change. **Never re-record just to make a failing replay pass** -- a replay
failure means the workflow code changed behavior for an existing history,
and the fix belongs in the workflow code (usually a new `patched()` branch),
not in the fixtures.
