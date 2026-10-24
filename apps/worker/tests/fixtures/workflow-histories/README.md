# Temporal replay fixtures

These histories come from the real time-skipping test server, using production
workflow modules and synthetic activity results. They contain no operator data.
`npm test -w @space/worker` replays every JSON file; it never rewrites a history.
Failures name both the history file and workflow ID.

After installing dependencies and building `@space/contracts`, record a reviewed
patched change from the repository root using a new version name:

```sh
npm run temporal:record-histories -w @space/worker -- --version continuation-v2
npm test -w @space/worker -- tests/temporal-replay.test.ts
```

The recorder first rejects reused version names, then replays **every retained
history** against the current production workflows using the same replay test
as CI. Any failure stops the command before recording scenarios or staging new
files. This check runs only for explicit recording; ordinary worker tests do
not replay the corpus twice.

Successful recording adds `WORKFLOW--continuation-v2.json` files while retaining
all older versions. New histories are generated in a temporary directory, and
the complete publication plan is validated before copying any files. Exclusive
creation prevents overwrites, even with identical contents; a failed copy rolls
back files created by that invocation. No force-overwrite option exists.

Only an initial, empty corpus can use the unversioned bootstrap command:

```sh
npm run temporal:record-histories -w @space/worker
```

The committed corpus is already populated, so that command intentionally fails
fast here. Temporal run IDs and timestamps naturally differ; those differences
never justify replacing an old history.

Record new-version histories only as part of a reviewed `patched()` change.
Never overwrite the previous version of a history, or regenerate a history
merely to make a failing replay pass. Retain pre-change histories when adding
fixtures for new branches: those old executions still need to replay.
Review the JSON diff and run replay against every retained history.

The test-only legacy loader removes only the supervisor's continuation patch
decision, causing the actual legacy implementation to execute on the test
server. Its recorded commands are replayed against unchanged current production
code. A separate test-only loader inserts a timer into the goal workflow; the
negative replay test requires `DeterminismViolationError`, proving the gate
detects incompatible command sequences. Neither loader modifies source files.

The SDK caches its downloaded time-skipping server binary. Initial setup needs
network access to download dependencies and that binary; test execution uses
only the local test server, with no database, Docker or provider access.

The dedicated `Temporal workflow acceptance` GitHub workflow runs the worker
acceptance tests with a 180-second budget, then runs the remaining worker
regressions without repeating the acceptance cases. It measures the added tests
externally with a monotonic clock, including global setup. Both a test failure
and a budget overrun fail CI; the job summary retains the timing report even
on failure. This workflow is separate from full repository CI; both still matter.
No duration assertions run in scenario teardown hooks.

Vitest global setup prepares the SDK's pinned time-skipping executable once in
`~/.cache/spaceapp-temporal-testing`. Scenario servers then start from that
existing binary and cannot trigger network downloads inside readiness hooks.
Every scenario still gets its own real server and isolated execution state.
Cold setup/download time remains included in the external suite measurement.
