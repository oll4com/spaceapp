# Synthetic Temporal replay histories

These fixtures must be recorded from the real time-skipping test server with
stub activities. They contain no database, provider account or user session data.
Recording removes host identities and diagnostic stack paths; event IDs,
commands, payloads and ordering remain server-generated. Never invent events.
Each JSON document stores the original synthetic workflow ID and a generated
protobuf JSON representation of its history. Recording verifies a lossless
protobuf byte round-trip before removing diagnostic identities and stack paths.
Replay restores the generated History message and uses the original workflow ID.

The ordinary worker tests replay every committed JSON file against the current
production workflow implementations. They also replay the dummy-turn history
against a test-only variant containing an extra timer and require a
`DeterminismViolationError`. Missing histories fail the gate rather than skip it.

After installing dependencies and building the internal packages with
`npm run check`, record the initial set from the repository root:

```sh
npm run temporal:record-histories -w @space/worker
npm test -w @space/worker -- temporal-replay
```

The recorder runs the real-sandbox suites serially. Ordinary tests never write
fixtures. The legacy recorder changes only the supervisor entry selector in a
test bundle so the existing legacy implementation produces a history without
the continuation patch marker. The replay gate uses the unmodified production
bundle: `patched()` must then select that legacy branch from history. Temporal
APIs, timers, child workflows, activities and continue-as-new are real.

Re-record an existing history **only together with a reviewed `patched()` change**,
after examining the old history and confirming the intended compatibility
behavior. The explicit overwrite command is:

```sh
npm run temporal:record-histories -w @space/worker -- --patched-change
```

Never re-record just to make a failing replay pass. Keep the old histories that
represent executions still supported in production, add new branch coverage,
and run both against the new code. Review fixture diffs together with the patch.
