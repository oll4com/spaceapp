# Workflow history compatibility

These histories contain synthetic IDs, activity results and signals from the
real Temporal time-skipping server. No database, provider or Docker is used.
The SDK downloads its test server on first use; subsequent runs can reuse it.

After `npm run check` builds the internal package exports, `npm test -w
@space/worker` runs the sandbox cases and replays every required JSON against the
current workflow bundle without rebuilding those packages. The existing root
public test command also builds the exports before running these tests in CI.
A separate test adds one timer to `dotGoalWorkflow` in a test-only bundle and
requires `DeterminismViolationError`, proving the replay gate rejects drift.

## Recording

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run check
npm run temporal:record-histories -w @space/worker -- --output /tmp/new-workflow-histories
npm test -w @space/worker
```

The recorder first runs every sandbox assertion into a temporary directory.
It publishes the complete nine-file inventory only after the suite passes.
An existing destination file is an error: the recorder never overwrites a
baseline, including if a file appears while the suite is running. The default
destination contains the committed histories and therefore refuses re-recording.
Use a new output directory, review the results, and add any new compatibility
fixtures under distinct names while preserving supported earlier histories.
Register each new fixture name (without `.json`) in `historyNames` in
`apps/worker/tests/support/workflow-sandbox.ts`. The replay test requires the
JSON inventory to match that list and replays every listed history.
The supervisor histories capture the first run, including all 250 polling
iterations and its continue-as-new event, rather than an empty successor.

The legacy recording bundle selects the existing pre-patch supervisor function
from production source, without changing the function body or mocking Temporal.
It emits no `room-background-continuation-v1` marker. Replaying that history
against the **unchanged current bundle** exercises Temporal's real `patched()`
compatibility branch. The test-only selector fails if the source shape changes,
so updating the legacy recording requires an explicit compatibility review.

After this initial fixture introduction, re-record histories **only together
with an intentional replay-safe `patched()` change**. Never re-record merely to
make a failing replay pass. Preserve histories for supported earlier branches;
new behavior should normally add a fixture rather than replace its predecessor.
Review synthetic payloads and the diff before committing generated histories.
