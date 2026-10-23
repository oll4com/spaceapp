# Synthetic workflow replay baselines

`temporal-sandbox.test.ts` starts a real disposable time-skipping Temporal
server, bundles the production workflow implementations, and runs real workers
with stub activities. No provider, database, Docker daemon or live installation
is contacted. The SDK may download its test-server executable on the first run;
later runs use its cache. All task inputs and activity outputs are synthetic.

The committed JSON histories are read-only during normal `npm test` runs. Every
history is replayed through `Worker.runReplayHistories` against the current
production bundle. A separately built negative variant inserts one actual
Temporal timer at the start of `dotGoalWorkflow`; its replay must return a
`DeterminismViolationError` identifying `dotGoalWorkflow.json`.

The pre-patch supervisor fixture is recorded on the same real server using a
test-only loader which selects the existing legacy production branch without
emitting `room-background-continuation-v1`. No Temporal API is mocked. Normal
replay does not use that loader: it must replay the history with the current
production implementation, which discovers the absent patch marker itself.
The loader asserts that its exact branch selector exists, so source drift fails
instead of silently fabricating a different workflow.

## Re-recording policy

Initial baseline creation runs the complete real-sandbox scenarios:

```sh
npm run temporal:record-histories -w @space/worker
```

Existing histories must **never** be replaced to make a failing replay pass.
Fix the incompatibility with an explicit, reviewed `patched()` change and keep
the older history as a compatibility fixture. Only in that same change may
new baselines be recorded, with the patch ID named explicitly:

```sh
npm run temporal:record-histories -w @space/worker -- --patched-change PATCH_ID
```

The command refuses an unqualified overwrite. A named patch writes additional
`WORKFLOW--PATCH_ID.json` fixtures with exclusive creation, keeping the original
files intact. It then replays every old and new baseline, including the negative
determinism check.
Review the history changes along with the workflow patch. Do not remove an old
fixture which covers an execution that can still be replayed.

Only non-command diagnostics (`identity` and failure `stackTrace`) are
normalized to synthetic labels to avoid committing host names or local paths.
Event types, order, IDs, patch markers, arguments, results, failure types,
commands and timing are preserved. The normalized histories themselves must
pass actual replay; this is not a hand-authored substitute for recorded runs.
Long timeout/continue scenarios are asserted live; representative histories
cover all eight workflows plus both supervisor branches without committing
several redundant copies of hundreds of identical polling cycles.
