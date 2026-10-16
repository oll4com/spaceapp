# Synthetic Temporal replay histories

These JSON files come exclusively from the isolated, real Temporal time-skipping test server. They contain synthetic IDs, activity responses and inputs; never record histories from an installed operator instance, customer data or provider sessions here.

The Temporal SDK downloads its test-server executable on first use, so a fresh environment needs network access for that initial download. On Apple Silicon, the SDK's time-skipping server requires Rosetta 2; the validated CI environment is Ubuntu on x86-64. No database, Docker service or AI-provider account is needed for these synthetic cases.

`npm test -w @space/worker` runs the sandbox cases and replays every checked-in history against the current production workflows. Missing, corrupt or incompatible fixtures fail the tests. The negative replay case adds a test-only timer before `dotGoalWorkflow` and must produce `DeterminismViolationError`. Normal tests never rewrite fixtures.

To explicitly record histories from the repository root:

```sh
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker
```

Review the JSON diff and the full test results before committing. After the initial fixture creation, re-recording is allowed only together with a reviewed, replay-safe `patched()` workflow change, with its reason documented in the PR. Never re-record simply to make a failing replay pass; it would replace the compatibility evidence you are trying to preserve.

The pre-patch supervisor fixture executes the literal legacy supervisor branch in the real sandbox without adding the newer patch marker. It is a test-only historical entry point, not a mock of `@temporalio/workflow`. Its recorded history must replay against the current production workflow, which selects the old branch when the new marker is absent.
