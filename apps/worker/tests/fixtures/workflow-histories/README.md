# Real Temporal trace contracts

This directory contains synthetic histories recorded by the pinned Temporal
TypeScript SDK's real time-skipping test server. They contain made-up room,
mission, turn, memory and goal identifiers, not production histories or user
data. `manifest.json` identifies each workflow, its original synthetic workflow
ID, source mode and SHA-256 digest. Replay retains the original ID because some
workflows derive child or action identifiers from `workflowInfo().workflowId`.

## Run the gate

Use the repository's supported Node 22 release. From a clean checkout:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run check
npm run test:temporal -w @space/worker
```

The same tests run in `npm test -w @space/worker`, `npm test`, and the public
quality CI job. No database, Docker, provider account, credentials or GPU is
used. The SDK may download its test-server binary on the first run. For a
pre-provisioned offline host, set `SPACEAPP_TEMPORAL_TEST_SERVER_PATH` to the
official time-skipping test-server executable. A cold install is not claimed
to be offline. Tests use
real workflow workers and stub activities; the continuation scenarios use the
existing in-memory store and real continuation activity functions.

Supervisor failure scenarios cover generic child failures, typed application
failures and serialized Temporal timeout causes through the real server. The
timeout-cause case injects a synthetic `TimeoutFailure` inside an application
failure; it verifies cause propagation, not elapsed timeout expiration. These
live scenarios retain the existing 46 stored history baselines, with only the
recording-path correction described below.

Every ordinary run executes the live contract scenarios and replays the stored
histories through `Worker.runReplayHistories`. It does not generate or rewrite
fixtures. All JSON files must be listed exactly once in the manifest. Recording
uses the proto package's matching protobuf serializer. It normalizes the exact
current checkout root in V8 stack-frame locations within protobuf
`Failure.stackTrace` fields to `/synthetic-spaceapp`, without mutating the input
history, then proves byte-for-byte protobuf round-trip preservation of that
normalized message before writing JSON. Payload bytes, including encoded
failure attributes, remain opaque and unchanged; this is not a general scrubber.
A separate bundle inserts
a timer before the goal workflow and must
raise `DeterminismViolationError`, proving the replay gate rejects an
incompatible command sequence. The suite also measures its real elapsed time
against the issue's 180-second incremental budget.

Replay uses two child processes, with a 45-second parent-side deadline for each.
Both finish or are killed before the next test starts. This bounds even a
synchronous infinite-loop regression in the SDK's debug-mode replay isolate;
ordinary promise/test timeouts alone cannot interrupt that case. No internal
SDK timeout or debug-mode override is used.

## Source provenance

The original recordings received one path-only correction: 44 recording-checkout
prefixes in 22 failure-stack fields across 11 histories were replaced with
`/synthetic-spaceapp`, and those 11 manifest digests were updated. No history was
re-recorded. Every other JSON byte, including event metadata and payloads, was
preserved. Failure stacks are workflow-visible diagnostic data, so replay
validation remains necessary; they are not ignored serialization metadata.
This correction does not remove the original paths from earlier Git commits.

- `current` runs the production workflow exports without modifications.
- `legacy` uses a TypeScript AST loader to export the exact dormant
  `legacyRoomAgentSupervisorWorkflow` body from the current production source.
  It does not mock `patched` or the workflow SDK. These histories have no
  `room-background-continuation-v1` marker and must replay through the actual
  current production entry point's pre-patch path.
- `historical` runs the supervisor from public commit
  `1d1d8cb814cbe494100dcae07a7d63d9d1cc0cc4` (2026-08-20). Relative import paths
  and a type-only input alias adapt the snapshot to this checkout; its workflow
  body is unchanged.
  It uses the current shared helper modules and therefore proves only the
  explicitly exercised simple completed-turn trace, not every old helper
  implementation. The newer legacy scenarios separately exercise monitoring,
  cancellation and rollover.

The Java time-skipping server caps workflow execution/run timeouts at ten
years and clips activity start-to-close timeouts to the recorded run timeout.
The native-session production policy requests 100 years, so its recorded
effective timeout is ten years here. The oracle checks the effective minimum
using the history's Started event rather than pretending the server retained
100 years. This is a test-server limitation, not a production timeout change;
see the official [server timeout cap](https://github.com/temporalio/sdk-java/blob/master/temporal-test-server/src/main/java/io/temporal/internal/testservice/TestWorkflowMutableStateImpl.java).

## Recording additional baselines

The recorder refuses to overwrite JSON files or record a partial scenario run.
Generate a candidate in a new empty directory, for example:

```sh
SPACEAPP_HISTORY_OUTPUT=/tmp/spaceapp-history-candidate \
  npm run temporal:record-histories -w @space/worker
```

Review the new synthetic histories and their source changes. Preserve existing
history files and manifest entries. Re-recording is allowed only alongside a
deliberate `patched()` workflow change that requires additional coverage. Keep
the old version's replay obligations. If a baseline stops
replaying, fix/version the production workflow rather than regenerating old
histories until the test turns green. Never record against an operator instance
or include real user data, credentials, provider output or production histories.

## Review provenance

The implementation and synthetic fixtures were prepared with AI assistance.
They are private, unsubmitted work until a person independently reviews the
source, runs the required checks, and decides whether to contribute it. Test
results are evidence of the stated checks only, not a payment or merge promise.
