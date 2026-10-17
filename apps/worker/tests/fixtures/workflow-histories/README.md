# Workflow replay fixtures

These histories are recorded by a real Temporal test server with the repository's
workflow code and deterministic in-process activity implementations. They contain
synthetic test inputs and results only. No production server or customer history
is involved.

Recording baseline: commit `98bcb385`, with Temporal TypeScript SDK `1.24.0`.
The pre-patch supervisor case uses that same source's retained legacy branch.

The replay test uses the real `Worker.runReplayHistories` API and the current
workflow sandbox bundle. It consumes every result and checks the SDK's per-history
error field. Replay is offline: it does not start a Temporal server or execute the
recorded activities.

JSON uses protobuf's `History.toObject` representation (string longs, enum names,
and base64 bytes). The test loads it through `History.fromObject` before replay,
restoring protobuf integers and payload bytes without changing the history.

| File | Workflow type | Compatibility covered |
| --- | --- | --- |
| `dotGoalWorkflow.json` | `dotGoalWorkflow` | Goal loop and its recorded activities |
| `dummyTurnWorkflow.json` | `dummyTurnWorkflow` | Start and completion activities |
| `codexAppServerTurnWorkflow.json` | `codexAppServerTurnWorkflow` | Agent-turn activity routing |
| `roomAgentSupervisorWorkflow.json` | `roomAgentSupervisorWorkflow` | Current background-continuation branch |
| `roomAgentSupervisorWorkflow-prepatch.json` | `roomAgentSupervisorWorkflow` | Legacy branch before `room-background-continuation-v1` |
| `roomAgentActionWorkflow.json` | `roomAgentActionWorkflow` | Background-action activity |
| `memoryMaintenanceWorkflow.json` | `memoryMaintenanceWorkflow` | Maintenance activities and consolidation child |
| `memoryConsolidationWorkflow.json` | `memoryConsolidationWorkflow` | Consolidation activity sequence |
| `memoryMutationWorkflow.json` | `memoryMutationWorkflow` | Persisted memory mutation activity |

The legacy supervisor history uses the real production bundle with the SDK's
`patchActivationCallback` deferring only `room-background-continuation-v1`.
This executes the retained legacy branch without recording that patch marker.
The replay suite then runs the history against today's
workflow code. It does not remove marker events or mock `patched()` during replay.
The suite also checks that the continuation patch marker is present in the current
case and absent from the pre-patch case.

Histories must remain immutable when a behavior change is made. Only record new
histories alongside a workflow change protected by `patched()`, retaining the
older compatibility histories. Add versioned recording names to the recorder and
the fixed fixture list in `workflow-replay.test.ts` so both old and new histories
are replayed. Never remove an old fixture or refresh one to hide a failed replay
or make CI green. Review the resulting diff and use the same pinned Temporal SDK
version for recording and replay (`1.24.0`).

The recorder creates files exclusively and fails with `EEXIST` if a target name
already exists. There is no overwrite option. Consequently, the command below
refuses to replace the committed fixture set in a normal checkout; it initializes
only absent target names. All executions finish before writes start, but the set
of file creations is not an atomic transaction.

To record with Node.js 22.12 or newer in the supported Node.js 22 line:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build -w @space/contracts
npm run temporal:record-histories -w @space/worker
```

The recorder is `apps/worker/scripts/record-workflow-histories.ts`. It starts its
own disposable Temporal test server, records all nine cases with the fixed
`replay-<fixture name>` workflow IDs, and tears the server down afterwards.
Worker and client identities are fixed synthetic values. Only local failure
stack traces are omitted; commands, event ordering, payloads and patch markers
are preserved. The fixtures use protobuf JSON (`History.toObject`) and the
replay test rehydrates them with `History.fromObject` before invoking the SDK.

Run replay from the repository root:

```sh
npm test -w @space/worker -- tests/workflow-replay.test.ts
```

The two adjacent `workflow-replay-timer.ts` and `workflow-replay-activity.ts`
fixtures are intentionally incompatible versions of `dummyTurnWorkflow`. They
insert a timer or a different activity before its original first activity. Both
must produce `DeterminismViolationError` when replaying the unchanged committed
history. This ensures the guard detects a changed command sequence instead of
only proving that history files can be parsed.
