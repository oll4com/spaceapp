# Workflow compatibility baselines

These are synthetic histories from the real Temporal time-skipping server and
the production workflow exports. Activity implementations alone are replaced.
No database, Docker, provider account or production history is used.

`npm test -w @space/worker` runs the live scenarios and replays **every** committed
history with `Worker.runReplayHistories`, checking each result's error. The root
public suite invokes these workspace tests, so replay failures fail ordinary CI.
`npm run temporal:test -w @space/worker` runs only the new live/replay checks for
measuring their wall-clock budget, including server and bundle startup.

The manifest records each original workflow ID, workflow type, scenario,
pre-patch status, SDK version, source revision/hashes and file checksum. JSON is
the pinned protobuf library's representation; the loader explicitly reconstructs
History objects before replay. Original workflow IDs matter to legacy action-ID
fallback behavior. The loader checks the manifest against the complete set of
JSON files and requires all eight types plus the pre-patch supervisor.

## Recording policy

The explicit command is `npm run temporal:record-histories -w @space/worker`.
It executes the real scenarios and creates the **initial** baselines only,
refusing to replace an existing manifest or history. Ordinary tests never write
fixtures. Failed scenario assertions prevent recording the initial manifest.

After the initial baseline, do not delete or regenerate histories just to make
a failing replay green. A reviewed, replay-safe `patched()` change must retain
the old history and add its new branch history, with a separately reviewed
additive recorder/manifest change. Review the workflow change, source provenance,
payloads and replay results together. SDK upgrades must replay existing fixtures.
Never import an operator's history, credentials, profile or database.

The legacy test bundle replaces exactly one continuation patch guard with false
in a test-only loader. It records a genuine history without that marker; the
positive replay uses unmodified production workflows. No Temporal API is mocked.
The negative test adds an unpatched timer in a separate test-only entry and
requires `DeterminismViolationError`, proving the gate detects incompatible code.

The live matrix covers dot wake/timers/300-iteration continuation, all turn routes
and failure/retry policies, action failure/cancellation compensation, both
supervisor branches' signals/cancellation/50-turn/250-poll continuation and every
assertion of the original mocked continuation suite, and maintenance/consolidation/
mutation retry, failure and actual child/cross-queue execution.
