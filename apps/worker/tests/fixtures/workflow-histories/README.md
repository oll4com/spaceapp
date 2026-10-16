# Recorded workflow histories

These JSON files are real Temporal histories, recorded from runs of the
production workflow code against a time-skipping test server with synthetic
stub activities (synthetic data only — no user data, no production input).
`tests/temporal-replay.test.ts` replays every file here against the current
workflow code on each test run: if a change alters the command sequence a
workflow issues for an existing history, replay fails with a determinism
error and CI goes red. That is the gate that keeps workflow edits safe for
executions that are already in flight.

## Re-recording

```sh
npm run temporal:record-histories -w @space/worker -- --force
```

The script (`apps/worker/scripts/record-workflow-histories.mjs`) refuses to
overwrite existing fixtures unless `--force` is passed, so histories are
never replaced by accident. It can also record against an already-running
time-skipping test server with `-- --address host:port`.

## When re-recording is allowed

Only together with an intentional, replay-safe workflow change: a
`patched()` gate (or `workerDeploymentVersioning` equivalent) that keeps old
histories replayable, plus the new histories recorded from the changed code,
in the same pull request.

Re-recording is **never** allowed just to make a failing replay pass. A
failing replay means the workflow change is not replay-safe for in-flight
executions; fix the change, not the fixture.
