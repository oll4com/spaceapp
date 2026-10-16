# Temporal workflow histories

`npm test -w @space/worker` runs the production workflows in Temporal's real
workflow sandbox with synthetic Activity implementations. Each scenario gets an
isolated time-skipping server; the production workflow bundle is compiled once
and reused. No database, Docker, provider account or application installation is
used. The first run downloads Temporal's test-server executable from Temporal;
subsequent runs reuse the SDK cache and communicate only with localhost. A cold
download is setup time and can be slower than the tests themselves. Apple Silicon
needs Rosetta to run Temporal's test-server executable.

`temporal-replay.test.ts` reads the committed JSON files and manifest and replays
every execution against the current production code. It does not start a server,
call Activities or regenerate files. A separate negative control adds a timer at
the beginning of `dotGoalWorkflow` and must produce `DeterminismViolationError`.
Replay failures identify the workflow and history filename.

## Recording

From the repository root, after installing dependencies and building the internal
packages with `npm run check`:

```sh
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker -- tests/temporal-workflows.test.ts tests/temporal-replay.test.ts
```

The explicit recording command runs the same asserted scenarios as the tests. It
fetches complete histories from the real test server, including each individual
continue-as-new run and child execution. The manifest retains the actual
workflow ID and server-assigned run ID; replay needs the workflow ID for code
that derives Activity arguments from it. IDs and payloads are synthetic, and
client/worker identities and Activity error stacks contain no host information.

JSON uses `@temporalio/proto`'s `History.toObject` representation (string longs,
base64 bytes and named enums). Replay restores it with `History.fromObject`;
do not pass the parsed plain JSON directly to the replay API. This also avoids
the SDK's reflection-based ProtoJSON converter requiring the same physical
`protobufjs` copy across dependencies. The conversion preserves every event,
timestamp and payload; it does not rewrite history.

The recorder first writes to a temporary directory and replays all recorded
executions against the current code. Only after that succeeds does it update
this directory. Review the manifest and JSON diff before committing. Do not edit
history events, remove patch markers, or change recorded inputs by hand.

The pre-patch supervisor histories are generated using the SDK 1.24.0
`WorkerOptions.patchActivationCallback`, disabling only
`room-background-continuation-v1`. The worker still loads the real production
definitions and the server records their actual commands. Replay uses the
unmodified current workflow code without that callback. No test replaces the
`@temporalio/workflow` module or copies an older supervisor implementation.

## When recording is allowed

Recording is allowed for the initial baseline, or together with a reviewed
`patched()` workflow change that requires new coverage. Preserve the relevant
older, pre-patch histories when extending coverage. **Never re-record histories
to make a failing replay pass.** Fix compatibility with the existing histories,
add the necessary patch branch and new history, and have the fixture changes
reviewed with that workflow change. Normal tests and CI must only read the
committed baseline.

The integration scenarios cover Dot wake/timeout/continuation, turn retries,
both supervisor branches (signals, child cancellation, 50-item and 250-poll
continuation), continuation preparation races and bounded queues, background
action failure recording, and memory failure recovery, children and retries.
The memory Activities use their production task queues with local stub workers.
