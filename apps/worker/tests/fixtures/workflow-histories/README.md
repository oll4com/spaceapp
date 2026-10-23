# Temporal workflow replay baselines

These JSON histories contain synthetic inputs from the real, time-skipping
Temporal test server. They cover all eight production workflow types, including
supervisor runs with and without `room-background-continuation-v1`. The tests
import the production implementations without replacing Temporal APIs.

`npm test -w @space/worker` runs the real-sandbox scenarios and replays every
committed JSON history with `Worker.runReplayHistories`. The public test command
and public CI include this workspace automatically. Replay failures identify the
history file. A negative test adds a timer in a test-only workflow and requires
`DeterminismViolationError`, proving that the gate detects incompatible changes.

No database, Docker, AI account or provider credentials are used. The SDK downloads
its official ephemeral test-server binary on first use; subsequent runs use its
local cache. Tests communicate only with their disposable local server. Use the
repository's supported Node 22 runtime.

## Recording histories

From the repository root, after installing the locked dependencies:

```sh
npm run build -w @space/contracts
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker
```

Normal test runs never write fixtures. Recording is an explicit operation and
runs the same asserted scenarios. Worker/client identities and exception stack
traces are scrubbed so contributor hostnames and local paths are not committed;
replay-relevant inputs, events and results are preserved.

After the initial baseline, **re-record only together with a deliberate,
replay-safe `patched()` workflow change**. Preserve an old history for each
supported branch and replay both old and new histories before submission.
Never re-record histories simply to make a failing replay pass: that discards
the evidence of an incompatible change. A fixture diff must be reviewed as
carefully as the workflow change it accompanies.

The pre-patch supervisor fixture is recorded from the unmodified implementation
using SDK 1.24's `patchActivationCallback`, which leaves only the named patch
inactive and records no marker for it. Ordinary replays use the current source
and the history's actual patch markers; the callback does not override replay.
