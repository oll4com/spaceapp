# Synthetic Temporal replay histories

These nine histories are recorded from real `TestWorkflowEnvironment.createTimeSkipping()` executions with synthetic inputs and in-memory activities. They contain no live namespace, provider, database, user account or credential data. JSON uses the generated protobuf `History.toObject` format (string enums/longs and base64 bytes), decoded with `History.fromObject` before replay. Ordinary tests never write these files. Missing, empty or wrong-workflow files fail the gate.

Run `npm test -w @space/worker`. The default suite executes every production workflow, replays all nine fixtures using `Worker.runReplayHistories`, and requires the extra-timer variant to throw `DeterminismViolationError`. The tests have a three-minute wall-clock budget. Each case owns a test server because time skipping is server-global. Bundling uses the real production workflow paths; only the test-only legacy loader replaces the single supervisor patch predicate with `false` to record and exercise the historical branch. The normal production bundle must replay that marker-free history.

## Re-recording policy

Re-recording is allowed **only together with a reviewed `patched()` workflow change**, preserving old-branch coverage. Never re-record a fixture to make a failing replay pass. First identify and fix the incompatible change; retain histories needed by existing executions. Review all history changes as code.

For an approved patch, run:

```sh
npm run temporal:record-histories -w @space/worker -- --patched-change NEW_PATCH_ID
npm test -w @space/worker
npm run check
```

The script checks that the named marker occurs in workflow source, but that check cannot replace human review that it is a new, appropriate compatibility patch. `--initial` is only for bootstrapping a checkout with no JSON histories; it refuses to overwrite existing files. Do not delete fixtures to bypass this protection.

The SDK downloads its test-server executable on first use. No live Temporal server, database, Docker daemon or AI provider is needed. For an air-gapped execution sandbox, acquire that executable separately, then set `TEMPORAL_TEST_SERVER_EXECUTABLE` to its local path before running the same commands. All activities in this suite are synthetic stubs; the continuation parity checks use the existing in-memory store fixture.
