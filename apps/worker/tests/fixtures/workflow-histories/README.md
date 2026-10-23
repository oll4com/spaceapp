# Temporal replay histories

These JSON fixtures are captured from synthetic executions on Temporal's real
time-skipping test server. They contain no installation data, provider calls,
database records or credentials. The normal worker test command replays every
history against the current production workflows and also checks that adding an
extra timer to `dotGoalWorkflow` produces `DeterminismViolationError`.

From a clean checkout, install dependencies and build the internal packages:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run check
npm test -w @space/worker
```

The recorder runs the same real-sandbox scenarios as the default test suite and
serializes the server's history using the Temporal SDK. Each fixture retains its
original synthetic `workflowId` alongside the SDK `history`, so code that derives
activity arguments from a workflow ID sees the same ID during replay. Host identity
strings and the checkout prefix in failure stack traces are normalized; recorded
events, commands, workflow IDs and payloads remain intact. Scenario failures discard
their staged histories and leave existing fixtures alone before publication.
The legacy supervisor fixture comes from executing its pre-patch branch with a test-only bundle; it is
then replayed against the unmodified current production workflow.

Existing histories must remain useful as compatibility contracts. Re-recording
is allowed **only together with an intentional, reviewed `patched()` change**,
never to make a failing replay pass. Inspect the workflow change and history diff
before using the explicit `-- --patched-change` argument. Preserve coverage of
old executions when adding new patch histories. Ordinary tests never write or
replace these fixtures.

Before publishing a replacement, `--patched-change` copies the existing fixture
unchanged to `<workflow>-pre-<unique-id>.json` in this directory. Every archived
history remains in the default replay discovery, with its original workflow ID.
Archives are never overwritten, including on repeated recordings. Duplicate
workflow IDs across current and archived fixtures still fail replay validation.

For an approved patch change, run:

```sh
npm run temporal:record-histories -w @space/worker -- --patched-change
npm test -w @space/worker
```

The command without `--patched-change` records an initial set only when no JSON
histories exist; it refuses to overwrite the committed fixtures.

On Windows, a deeply nested temporary directory can prevent the native test
server from creating its local sockets. For such hosts, select an existing short
temporary directory with `TEMP` and `TMP` for the test command. Linux is the
reference CI environment; tests never start Docker or an installed application.
