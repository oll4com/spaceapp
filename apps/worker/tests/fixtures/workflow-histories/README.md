# Temporal sandbox and replay baselines

`npm test -w @space/worker` runs the real eight production workflows, real
signals, timers, children, activity retries and continue-as-new on an isolated
`TestWorkflowEnvironment.createTimeSkipping()` server. No database, Docker,
provider credentials or installed SpaceApp instance is used. The SDK may
download its test-server binary on the first run; subsequent runs use its cache.
Scenarios use fresh servers so cancellation and unfinished activities cannot
leave another scenario's virtual clock locked. Compiled bundles are shared.
Workers and each server are closed in `finally`, including assertion failures.

`temporal-sandbox.test.ts` also replays **every committed JSON file here** with
`Worker.runReplayHistories`, using the current production workflow bundle. An
additional test inserts a timer in a test-only Dot workflow and requires an
actual `DeterminismViolationError`. Replay failures name the JSON fixture and
workflow run. Neither normal test command rewrites histories.

## Recording

After installing dependencies and building the internal packages (`npm run
check`), use:

```sh
npm run temporal:record-histories -w @space/worker -- --confirm-patched-change --patch=your-patch-id
npm test -w @space/worker
```

Re-recording existing baselines is allowed **only together with a reviewed
`patched()` compatibility change**, never to make a failing replay pass. Keep
old histories that exercise the old branch; add a separately named baseline for
the new branch. Review the old-to-new diff and the patch's replay results. The
recorder's explicit flag acknowledges this rule; it does not establish that a
patch is correct. A patch suffix adds new files and existing histories are never
overwritten. The first baseline was captured with `--initial-baseline`; that
mode refuses to run when JSON baselines already exist.

Histories are fetched from completed, continued or explicitly terminated
synthetic executions on the real SDK test server. They use the SDK protobuf
message's lossless JSON representation (int64 strings and base64 bytes). The
replay reader restores `temporal.api.history.v1.History.fromObject` before
passing the protobuf history to the worker. Events, commands, timestamps and
patch markers are not fabricated or edited. Identities are fixed synthetic
strings; activity-failure stacks are synthetic and contain no host paths.

## Pre-patch branch

`tests/support/legacy-supervisor-workflows.ts` freezes the existing legacy
supervisor from upstream `adb96ac77531649bd335078aacaa0318ce1d20a2`. Its only
dispatch change selects that legacy implementation without calling `patched`;
relative imports point at the same production helpers. It runs inside the real
workflow sandbox to record genuine **unmarked** histories, including children,
signals, polling and continue-as-new. Replay always uses current production
code: the absence of the patch marker selects its compatibility branch.
The test asserts that legacy fixtures contain no patch marker. No SDK API or
`patched()` return value is mocked.

The historical implementation clears `interrupted` when it continues after
50 items; its fixture records this existing behavior. The current branch keeps
those items. This test contribution preserves production behavior rather than
silently changing an old history's command sequence.

Supervisor scenarios also exercise every assertion in
`room-supervisor-continuation.test.ts` through the actual Temporal runtime.
The same in-memory activity-side store helpers verify mission/turn state,
single-send behavior, stale continuation retirement and queue bounds. Timeout
cause classification is injected as an SDK `TimeoutFailure` at the activity
boundary and serialized through an actual child workflow; it does not wait for
a production-length timeout. Heartbeats deliver cancellation to the active
child in the stop-signal scenarios.
