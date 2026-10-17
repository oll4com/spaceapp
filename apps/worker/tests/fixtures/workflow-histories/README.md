# Synthetic Temporal replay histories

`../../temporal-sandbox.test.ts` runs all eight production workflows on the SDK
1.24.0 time-skipping test server, with local stub activities. There is no database,
Docker, provider account or production Temporal connection. The SDK downloads its
test-server binary on first use; subsequent runs use the local cache. Normal test
runs only read the committed JSON files and replay every history against the
current production workflow bundle.

From the repository root, with Node 22 and dependencies installed:

```sh
npm test -w @space/worker -- tests/temporal-sandbox.test.ts
npm run temporal:record-histories -w @space/worker
```

**Re-recording existing histories is allowed only together with a reviewed
`patched()` migration, never to make a failing replay pass.** Keep the old
histories to prove that pre-migration executions still replay, and add newly named
fixtures for the new branch. Review every fixture diff and replay the complete
corpus before committing. Adding a new scenario may add a new synthetic history;
it must not silently replace an existing compatibility baseline.

The explicit recording command writes histories from the scenario tests before
running the replay gate. Do not use it as a repair command. Normal `npm test`
never updates fixtures. To check a workflow edit, use the first command above.

The test-only webpack pre-loader builds the supervisor as it existed before
`room-background-continuation-v1`: it replaces that patch check with `false`.
The resulting legacy histories contain no patch marker and are replayed using
unchanged current production code. Another test-only variant inserts an extra
timer into `dummyTurnWorkflow`; its replay must fail with
`DeterminismViolationError`, proving the gate detects a command mismatch.

Each JSON object contains `workflowId` and protobuf-compatible `history`.
Payloads, UUIDs, timestamps, failure stacks and worker identities are generated
by this synthetic test run. No live execution history or credentials are used.
Histories include retry/failure, signal, child-workflow and continue-as-new events;
they are intentionally complete rather than trimmed event snapshots.

The suite is discovered by the worker's normal Vitest configuration, and therefore
runs in `npm test -w @space/worker`, `npm run test:public` and public CI. Each
scenario owns its test server so virtual-time lock state cannot leak between
infinite supervisor executions. The workflow bundles are compiled once per file.
