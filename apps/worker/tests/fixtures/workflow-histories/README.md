# Synthetic Temporal replay histories

These histories come from real executions of the production workflows on
`TestWorkflowEnvironment.createTimeSkipping()`, with synthetic activity results.
They contain no operator data, credentials, provider output or database state.
Each JSON envelope preserves the original `workflowId`, workflow type and
current/legacy branch. Preserving the ID matters for workflows that derive an
action ID from `workflowInfo().workflowId`.

`temporal-replay.test.ts` reads every committed JSON file and replays it against
the current production bundle with `Worker.runReplayHistories`. Every result is
checked, including the count; missing workflow coverage fails. A test-only
bundle with an extra unpatched timer must produce `DeterminismViolationError`.
Supervisor histories are checked for the real patch marker and legacy-only
activity commands, so an envelope's branch label alone cannot establish
pre-patch coverage. Rollover and successor histories preserve their individual
run events while retaining the original workflow ID.
Normal tests never create or replace histories.

## Initial recording

After installing locked dependencies and building the internal packages:

```sh
npm run temporal:record-histories -w @space/worker -- --initial
npm test -w @space/worker -- temporal-replay
```

`--initial` is only for creating the first baseline in an empty fixture
directory. It refuses to run when a JSON fixture already exists. The recorder
executes the same basic and supervisor scenario assertions as the sandbox
suite, including a test-only pre-patch supervisor bundle. It writes only after
all scenarios finish and uses exclusive creation, so existing files cannot be
overwritten. Installation and the first Temporal test-server download require
network access; the workflows use local stub activities and need no external
service or AI provider.

Supervisor scenario groups use fresh ephemeral servers to avoid retaining
test-server time-skipping locks after an infinite supervisor is terminated.
Each group still runs the real production workflow and SDK. Synthetic client
and worker identities and stable stub-error stacks keep host details out of
the saved histories. The timeout-mapping case supplies a synthetic
`TimeoutFailure` cause through the real failure converter; it does not claim
to wait for a production activity timeout to expire.

## Re-recording policy

Re-recording is allowed **only together with a reviewed, replay-safe
`patched()` workflow change**, never to make a failing replay test pass. Keep
the old histories to prove existing executions remain compatible. Add the new
generation with the exact patch ID:

```sh
npm run temporal:record-histories -w @space/worker -- --patch my-workflow-change-v1
npm test -w @space/worker
```

The command requires that the production workflow source contains the matching
`patched()` call. It creates `patch-<id>-*.json` files and refuses to replace an
existing generation. This mechanical guard does not replace code review:
reviewers must check the workflow change, its compatibility branch, the
synthetic data and the new histories together. A failing old history is a
compatibility regression to investigate, not a reason to delete the baseline.

Do not pass an installed Temporal instance or operator credentials to this
recorder. Each run owns and tears down its ephemeral local environment.
