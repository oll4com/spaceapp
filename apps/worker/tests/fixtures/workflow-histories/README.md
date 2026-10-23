# Temporal replay compatibility fixtures

These JSON histories are recorded from the real `TestWorkflowEnvironment`
time-skipping server, production workflows and synthetic activity results.
They contain no operator instance data or provider calls. Stack traces and
worker identities are redacted during recording; event order, commands,
payloads and timing are not rewritten.

`npm test -w @space/worker` executes the sandbox scenarios and replays every
committed JSON file using `Worker.runReplayHistories`. The suite also bundles
a test-only extra activity into `dummyTurnWorkflow` and requires replay to
report `DeterminismViolationError`, so a broken gate cannot pass silently.

The legacy supervisor fixtures are produced by a strict test-only webpack
loader that substitutes `false` for exactly one occurrence of
`patched("room-background-continuation-v1")`. They therefore contain no new
patch marker and replay the pre-patch branch against the unmodified current
production bundle. The loader is never registered by production workers.

## Recording policy

To reproduce all fixtures deliberately:

```sh
npm run temporal:record-histories -w @space/worker
```

Normal test runs only read fixtures. Initial fixtures establish this gate.
After that, re-recording an existing history is permitted **only together
with a replay-safe `patched()` workflow change**, with its patch ID and
compatibility reasoning in the PR. Never regenerate fixtures just to make a
failing replay pass. Keep old histories to exercise both sides of a patch;
record the new branch under a new name. New scenarios can add new files.

The initial synthetic histories target the main commit recorded in the
contribution report. All eight workflow entry points, activity retries,
supervisor polling and both supervisor branches are covered. No workflow
logic is modified by this contribution.

The SDK downloads and caches its official time-skipping server on first use.
Subsequent execution needs no database, Docker, provider account or network
service. Every scenario gets a fresh server and independent virtual time;
workflow bundles are reused to avoid recompiling for each case.
