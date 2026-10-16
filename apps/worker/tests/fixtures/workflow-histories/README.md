# Real Temporal replay fixtures

These JSON files are recorded by the real production workflow entry points in a
`TestWorkflowEnvironment.createTimeSkipping()` server with synthetic activity
results. They are not mocked workflow execution or hand-written event histories.
Each envelope preserves the actual workflow ID (needed by workflows that derive
child IDs from it), workflow type and protobuf-JSON history from `fetchHistory()`.
There must be a recording for every one of the eight production workflow types
and a separate supervisor history generated with the pre-patch continuation
branch selected using the SDK's `patchActivationCallback`. This is a synthetic
baseline of the legacy behavior, not a customer's historical execution.

From the repository root, after installing the locked dependencies and building
the internal packages:

```sh
npm run temporal:record-histories -w @space/worker
npm run temporal:test -w @space/worker
```

The record command runs the real `temporal-*.test.ts` integration suites, excluding
the replay suite. Only explicit recording mode writes fixtures; normal tests read
the committed histories and fail if any required recording is missing. Synthetic
payloads must not contain credentials, real user text or customer records.

## Default test and CI coverage

`npm test -w @space/worker` uses Vitest's normal test discovery, so it includes
the real-sandbox suites and the replay gate without an opt-in environment flag.
The root `npm run test:public` builds the internal packages and runs
`npm test --workspaces --if-present`, which includes the worker workspace.
The existing `.github/workflows/ci.yml` public-quality job runs that same command
against its sanitized public candidate. The public exporter includes these test
files and JSON fixtures. No second job bypasses the export-provenance check.

To measure just the added suites on Linux after the internal packages are built:

```sh
time timeout 180s npm run temporal:test -w @space/worker
```

The acceptance budget is less than three minutes on GitHub's `ubuntu-latest`.
The command above enforces a local three-minute ceiling; a local run does not
certify a GitHub runner measurement. The normal CI gate reads the committed
fixtures and never re-records them. Its workflow trigger and full workspace
test commands remain unchanged.

`Worker.runReplayHistories` replays the fixtures against the current production
code. The negative test substitutes a test-only `dummyTurnWorkflow` with an extra
timer; it must fail with `DeterminismViolationError` and prints both the workflow
type and history file. It does not alter production code or any golden history.

Do not re-record histories merely to make replay pass. For subsequent behavior
changes, first preserve the old fixtures, introduce a replay-safe `patched()`
branch, and add a separately recorded history for the new behavior in the same
reviewed change. Re-recording is allowed only together with that deliberate
`patched()` change; the one-time initial fixture creation is the baseline.

The time-skipping server may require a first-use download. The executed workflows
use stub activities and need no provider account, database or Docker service.
