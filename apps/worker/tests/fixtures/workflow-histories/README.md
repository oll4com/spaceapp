# Synthetic Temporal histories

`npm test -w @space/worker` runs the production workflows on an ephemeral
`TestWorkflowEnvironment.createTimeSkipping()` server with stub activities, and
replays every JSON history listed in `manifest.json`. It never records or rewrites
these fixtures. No database, Docker, credentials, or AI provider is used. The SDK
downloads its test-server binary on first use; subsequent runs can use its cache.
On Apple Silicon the SDK's test server currently needs Rosetta.

The nine small histories cover all eight workflows plus the supervisor's pre-patch
branch. Both supervisor workers use the identical bundle built from the real
workflow source path. The recording worker's `patchActivationCallback` disables
only `room-background-continuation-v1` for the pre-patch execution; its history has
no patch marker. Replay uses the current bundle with no callback. Live tests cover
the 50-turn and 250-poll thresholds without checking in their large histories.

Run the bounded suite. Public CI runs it on `ubuntu-latest`; the runner reports
wall-clock time and fails if it reaches the 180-second budget:

```sh
npm run build -w @space/contracts
npm run build -w @space/memory-graph
npm run temporal:test -w @space/worker
```

The negative test replays the committed dummy-turn history against a test-only
workflow with an extra timer, and requires `DeterminismViolationError`. A normal
replay failure names the workflow type and fixture. Fix workflow compatibility;
never replace an old history just to make a failing replay pass.

To inspect a fresh recording without replacing the compatibility corpus:

```sh
npm run temporal:record-histories -w @space/worker -- --output /tmp/space-histories-review
```

All workflow recordings finish before any history files are written. A workflow
failure leaves existing histories unchanged and creates no partial corpus.
The recorder refuses to overwrite JSON by default. Re-recording committed
histories is allowed **only together with a reviewed `patched()` workflow change**.
Preserve histories for both sides of the patch; add new cases and manifest entries
when necessary. After reviewing that change, an explicit replacement uses:

```sh
npm run temporal:record-histories -w @space/worker -- --force --patch-id your-patch-id
npm test -w @space/worker
```

Review every history and manifest diff. Inputs, activities, client/worker identity
and task queues are synthetic. Failure stack traces are stripped; recorded
commands, payloads and event order are preserved. The JSON is the SDK protobuf
object representation; the replay test restores it with `History.fromObject`.
The manifest pins the SDK version and each file's SHA-256. The recorder owns its
server and terminates entire continue-as-new chains in `finally`, then tears down
the server. It cannot connect to an operator's Temporal namespace.
