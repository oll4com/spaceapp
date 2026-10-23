# Temporal replay fixtures

These are histories produced by the real Temporal time-skipping test server and
SDK 1.24.0, using production workflow exports and synthetic, stubbed activities.
They contain no operator data, credentials, database connection or provider call.
The test worker and client use a fixed synthetic identity. The initial baseline
is `adb96ac77531649bd335078aacaa0318ce1d20a2`.

`npm test -w @space/worker` runs the real-sandbox scenarios and replays **every**
JSON history in this directory with `Worker.runReplayHistories`. It also runs a
negative replay against a test-only `dotGoalWorkflow` with an extra timer, and
requires `DeterminismViolationError`. A positive replay failure names its
workflow/history file. The gate never records or modifies fixtures.

## Re-recording

From the repository root, using the Node version specified in `CONTRIBUTING.md`:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run build -w @space/contracts
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker -- tests/temporal-workflows.test.ts --testNamePattern="recorded production workflow replay"
```

The recorder starts isolated loopback time-skipping servers, runs all eight
production workflows, fetches their real histories, and writes nine JSON files.
The supervisor is long-lived: its fixture polls one monitored mission to
completion and is then deliberately terminated while idle. The pre-patch case
uses the SDK's `patchActivationCallback` to leave only
`room-background-continuation-v1` inactive. This executes the actual legacy
branch in production source, without rewriting source, mocking workflow APIs,
or manufacturing history events. Replay uses the normal current bundle, with
no patch override.

The first fixture set establishes this baseline. After that, re-recording is
allowed **only together with an intentional, replay-safe `patched()` workflow
change**, with review of why the change needs a new fixture. Preserve old branch
histories needed to prove compatibility, and add new fixtures for new branches.
Never re-record histories merely to make a failing replay pass. Investigate and
fix an incompatible workflow change instead. Ordinary test or activity-stub
edits are not permission to replace these fixtures.

Fixture data is synthetic, but timestamps and execution UUIDs naturally vary.
Review the diff and rerun the replay gate before committing. Do not import live
operator histories into this directory.

## Test isolation and observed legacy behavior

The single `temporal-workflows.test.ts` entry runs all scenarios serially with
one shared time-skipping server and reusable SDK workers for ordinary scenarios.
The two 250-poll clock-advancement scenarios use fresh servers, avoiding shared
test-clock state across long advances. Activity implementations are reset
between scenarios, execution IDs are unique, and supervisors are terminated at
the end of each successful case. A rejected scenario discards the workers and
server before the next case, rather than letting unfinished work call another
case's stubs. An internal callback deadline rejects before the outer test
timeout so cleanup can execute; observation waits allow bounded cold startup.
Known execution run IDs are bound to their originating scenario, rejecting late
activity delivery rather than routing it to the next scenario. The recorder
uses fresh servers and workers.

The test worker uses a 15-second V8 execution watchdog for all activations,
including initialization, because the production contracts bundle can exceed
the SDK's five-second default during cold initialization
on constrained machines. This does not change production workflow/activity
timeouts, retry policies, or server versions. Keep reporting measured wall time;
this guard is not evidence that the three-minute CI budget has been met.

The suite also includes a deliberately named compatibility characterization:
`characterizes legacy ignored input and lost queued interruptions at the 50-turn rollover`.
The existing pre-patch branch ignores carried `interrupted` input and writes an
empty interruption list at rollover. A queued stop can therefore lose its
mission-finalization action at that boundary. The current branch's carried
interruption test asserts preservation. No production behavior is changed here;
maintainer review must decide whether the legacy finding needs a separately
versioned fix. Passing the characterization is not a claim that the legacy
behavior is correct or that every possible state interleaving is preserved.

## Acceptance map

- `temporal-basic-workflows.scenarios.ts`: real dot-goal wake/timeout/continuation,
  turn routing and retries, action failure reporting and cancellation, optional
  maintenance failure recovery, real consolidation/mutation children, and
  exhausted required activity failures.
- `temporal-supervisor.scenarios.ts`: real current and pre-patch supervisor signals,
  interruption, one-second polling, 50-item and 250-poll continuation, bounded
  carry queues, and the existing mocked continuation assertions repeated with
  real workflow/child execution. The legacy edge above is explicitly disclosed.
- `temporal-replay.scenarios.ts`: all nine required synthetic histories, branch-marker
  and completed-settlement checks, plus the intentional extra-timer negative.

No workflow or activity implementation is changed. The existing worker test
command automatically discovers these files; the root public suite and CI run
that worker command. Tests need no Docker, database, or AI-provider credentials.
A successful local run is not an Ubuntu CI timing result. Measure the added
suite on the target runner before claiming the under-three-minute criterion.
