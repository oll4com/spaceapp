# Synthetic Temporal compatibility histories

`npm test -w @space/worker` runs the real time-skipping integration suite and
replays every JSON file here against the current production workflows. The
bundle entry in `tests/support/temporal-real-workflows.ts` only re-exports the
eight real implementations. Activities use synthetic fixtures: no database,
Docker instance, provider account, credentials or installed operator instance.
The first use of `@temporalio/testing` downloads its test-server executable;
subsequent runs reuse the SDK's cache. The cases run serially, reusing the compiled
workflow bundle but creating an isolated server and clock for each case. Workers
and the server are torn down in cleanup, including after a failed assertion or
partially initialized worker setup. This keeps termination of one continuation
chain from changing the next case's time-skipping state.

Each JSON contains the original synthetic `workflowId` and its server-recorded
`history`. Retaining that ID matters when code uses `workflowInfo().workflowId`.
Only failure-stack metadata is sanitized to remove local checkout paths. Event
ordering and command/activity payloads are not rewritten. The recorder sets
explicit synthetic client and worker identities. JSON is restored with the
public `temporal.api.history.v1.History.fromObject` protobuf API before replay;
this preserves payload bytes and avoids coupling to the identities of npm's
separate `protobufjs` copies. Replay errors are still checked individually.

The supervisor's legacy history is recorded with SDK 1.24.0's official
`patchActivationCallback`, returning false for
`room-background-continuation-v1`. That runs the existing pre-patch branch in
the real sandbox and emits no marker for that patch. Normal replay has no
callback: Temporal selects the old branch from the recorded history itself.
No production source transformation or mock of `@temporalio/workflow` is used.

## Recording

From the repository root, after the locked dependency install and prerequisite
workspace builds:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run check
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker
```

The initial addition creates the baseline. After that, **re-recording is only
allowed together with an intentional, replay-safe `patched()` change**. Never
re-record a history to make a failing replay green. Retain the old compatibility
histories and add coverage for the new patch branch; explain any deliberate
fixture migration in the same PR. Normal test runs never rewrite JSON files.
Review the fixture diff for synthetic-only data and inspect which commands and
patch markers changed before committing it.

The test-only variant in `temporal-nondeterministic-workflows.ts` adds one timer
before `dotGoalWorkflow`. Its negative replay must report a
`DeterminismViolationError`. The positive replay assertion includes both the
workflow ID and fixture filename, so introducing that timer into production
makes the ordinary test command fail with an identifiable compatibility error.

## Required baseline inventory

| File | Production workflow exercised |
| --- | --- |
| `dot-goal-wake.json` | `dotGoalWorkflow` |
| `dummy-turn-retry.json` | `dummyTurnWorkflow` |
| `codex-turn-retry.json` | `codexAppServerTurnWorkflow` |
| `supervisor-current-continuation.json` | Current `roomAgentSupervisorWorkflow` |
| `supervisor-legacy-continuation.json` | Pre-patch `roomAgentSupervisorWorkflow` |
| `room-action-failure.json` | `roomAgentActionWorkflow` |
| `memory-maintenance-child.json` | `memoryMaintenanceWorkflow`, real consolidation child |
| `memory-consolidation-change.json` | `memoryConsolidationWorkflow` |
| `memory-mutation-retry.json` | `memoryMutationWorkflow` |

The suite fails if this inventory is missing, empty or replaced by an unrelated
set of histories. Integration cases additionally exercise continuation state,
the 50-item and 250-poll thresholds, interruption, signal races, activity
retry/exhaustion and the existing in-memory continuation regressions.
