# How to re-record workflow histories

The replay gate in `workflow-replay.test.ts` compares the workflow code in
`apps/worker/src` against the histories in `fixtures/workflow-histories/`.
Every workflow that ships must have at least one recorded history, and every
recorded history must replay without a determinism violation.

## Record

```sh
cd apps/worker
node --experimental-strip-types --no-warnings tests/workflow-histories.mts --record
```

This starts a time-skipping Temporal test environment, runs one instance of
each workflow with stub activities, and writes the closed run's events to
`tests/fixtures/workflow-histories/<workflowName>.json`. The history is read
only after `result()` resolves: an earlier read returns the first events of a
still-open run, which replays trivially and would hide a determinism break.

## When re-recording is allowed

Only together with a `patched()` change, in the same commit. Never re-record to
make a failing replay pass: a replay failure means a running execution would
break on the new code, and replacing the history erases exactly the evidence
that says so.

## Adding a workflow

Add it to `recordHistories()` in `workflow-histories.mts` with stub activities,
record, and confirm `workflow-replay.test.ts` replays the new file. If the
workflow lives in its own module (as `memoryMaintenanceWorkflow` and
`memoryMutationWorkflow` do), add the module to `bundleFor()` in
`workflow-replay.test.ts` so the history is replayed against the bundle that
worker actually ships.

## Proving the gate still bites

`fixtures/replay-violation-workflows.ts` is a test-only variant that schedules an
extra activity before the recorded one. `workflow-replay.test.ts` replays the
recorded `dummyTurnWorkflow` history against it and expects a
`DeterminismViolationError`. If that test ever passes without an error, the gate
is no longer wired to real replay.
