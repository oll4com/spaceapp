# Temporal workflow histories

These histories come from the real `TestWorkflowEnvironment.createTimeSkipping()`
server, using the production workflow functions and synthetic activities. They
contain no operator data or provider credentials. They are compatibility
fixtures, not snapshots to update when a test fails.

Run from the repository root after `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`:

```sh
npm run check
npm run temporal:check -w @space/worker
npm test -w @space/worker -- tests/temporal-workflows.test.ts
```

The suite also runs in the normal worker tests and `npm run test:public`. The
dedicated CI job enforces a 180-second limit for this suite. Dependency installation
and TypeScript builds happen before that timer.

No PostgreSQL, Docker, AI provider, or external service is used by the tests.
The SDK downloads and caches its test-server executable on first use; an offline
machine must have that executable cached in advance. Apple silicon requires
Rosetta 2 for the SDK's time-skipping server. A new server is created for each
test because time skipping is global, particularly around terminated
continue-as-new chains. Production workflow bundles are compiled once and reused.
Workers, activities, connections, and test servers are shut down after each test.

## Coverage

| Workflow | Recorded scenarios |
| --- | --- |
| `dummyTurnWorkflow` | Activity retry and successful completion |
| `codexAppServerTurnWorkflow` | Room-agent Codex retry and completion, OpenCode, CLI, and native Chat activity options |
| `dotGoalWorkflow` | Wake signal, timeout, and a real 300-iteration continue-as-new |
| `roomAgentSupervisorWorkflow` | Current and pre-patch 50-item and 250-poll boundaries; prepared continuation; bounded carry queue |
| `roomAgentActionWorkflow` | Exhausted activity retries and the patched failure handler |
| `memoryMaintenanceWorkflow` | Failed optional activities, retries, and a real consolidation child |
| `memoryConsolidationWorkflow` | Mutation retry across its dedicated task queue and finalization |
| `memoryMutationWorkflow` | Repeated activity failures followed by success |

Live tests also cover enqueue/deduplication, stopping an active child in both
supervisor branches, and every case in `room-supervisor-continuation.test.ts`.
The continuation cases use its in-memory fixture as the activity backend;
Temporal's timers, signals, child workflows, retries, and sandbox are not mocked.

For the pre-patch recordings only, `temporal-legacy-loader.cjs` replaces the
single `patched("room-background-continuation-v1")` decision with the legacy
branch. The original legacy function executes in the real sandbox, without a
patch marker. Replay always uses the unmodified production bundle, so it must
correctly select that old branch from the committed history. No history events
are invented, removed, or changed to force that selection.

Each JSON file contains the workflow ID and a protobuf JSON object. The ID is
required because the background action derives its legacy action ID from it.
`History.toObject`/`History.fromObject` preserve int64 values and binary payloads
as strings/base64. Diagnostic stack traces are replaced with `synthetic-fixture`
to avoid recording local paths; all commands, payloads, and patch markers remain
the ones returned by the server. Client and worker identities are synthetic.

## Recording policy

Initial capture:

```sh
npm run temporal:record-histories -w @space/worker
```

The recorder runs the live tests into a temporary directory and copies their
new histories only after every live assertion passes. Exclusive creation preserves
every existing fixture, including old patch branches. The recorder reports skipped
names; use a distinct name in the test when adding a new branch. Direct recording
also refuses to overwrite a file. Normal test runs never write
fixtures. The replay and deliberately incompatible-workflow tests are skipped
only during recording, then must pass in a separate normal test run.

After the initial baseline, re-record only together with an explicitly reviewed,
replay-safe `patched()` workflow change. Preserve the old histories needed to
cover running executions and add the new branch's histories under distinct
names. Review the fixture diff and run the full replay gate before committing.
Never re-record to make failing replay pass. An unexplained determinism failure
requires a compatibility fix to the workflow, not a new baseline.

The negative control adds a timer before `dummyTurnWorkflow`'s first activity and
must fail with `DeterminismViolationError`. It protects against a replay gate
that accidentally stops validating workflow commands.
