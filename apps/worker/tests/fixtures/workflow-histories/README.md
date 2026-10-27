# Workflow history compatibility

These histories contain synthetic IDs, activity results and signals from the
real Temporal time-skipping server. No database, provider or Docker is used.
The SDK downloads its test server on first use; subsequent runs can reuse it.

`npm test -w @space/worker` builds the internal package exports, then runs the
sandbox cases and replays every required JSON against the current workflow
bundle. The existing root public test command and CI include these tests.
A separate test adds one timer to `dotGoalWorkflow` in a test-only bundle and
requires `DeterminismViolationError`, proving the replay gate rejects drift.

## Recording

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker
```

The recorder first runs every sandbox assertion into a temporary directory.
It publishes the complete nine-file inventory only after the suite passes.
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
