# Real Temporal histories

These JSON files contain only synthetic test data recorded from the real
`TestWorkflowEnvironment.createTimeSkipping()` server. They are replayed against
current production workflow code on every worker test run. No database, provider
account or Docker is needed. The first test run may download Temporal's test
server; subsequent runs reuse the SDK's cached binary.

From the repository root, after installing dependencies and building contracts:

```sh
npm run temporal:record-histories -w @space/worker
npm run check:temporal-tests -w @space/worker
npm test -w @space/worker
```

**Do not re-record histories merely to make a failing replay pass.** After the
initial fixture introduction, re-recording is allowed only together with a
reviewed `patched()` workflow change. The recorder never overwrites an existing history. A distinct recording uses
a SHA-256-suffixed filename and is added to `manifest.txt`; identical bytes are
reused. Baseline and all earlier versions remain in the replay set. Preserve old
branch histories so existing executions remain covered. Review the history diff and explain it in the PR.

`history-variant-loader.cjs` creates a test-only historical bundle by replacing
only the `room-background-continuation-v1` patch decision with `false`. All other
production code and the real Temporal sandbox remain intact. Histories recorded
with that bundle contain no marker for that patch and must replay through the
pre-patch branch of the unchanged current production bundle. This is not a mock
of Temporal. The separate negative variant adds a timer before the first dummy
turn activity and at the beginning of the Dot goal workflow; both histories must throw `DeterminismViolationError`.

Recording uses the same assertions as ordinary tests. The checked-in fixtures
are read only in normal CI runs. They must never contain production histories,
credentials, prompts or transcripts.

The recorder clears failure `stackTrace` fields before writing JSON, so local
workspace paths and source line numbers do not enter fixtures. This affects
diagnostic metadata only: event order, command attributes and payloads are
preserved. Removing these traces from existing fixtures is metadata cleanup,
not re-recording; the same histories must still pass the replay gate.

## Coverage

`tests/temporal-sandbox.test.ts` bundles production exports once, then starts a
fresh time-skipping server for each scenario. This isolates test-server activity
locks left by terminated long-lived supervisors. All activity inputs and results
are synthetic; no provider, database, or operator instance is contacted.

| Workflow | Real-sandbox assertions |
| --- | --- |
| Dot goal | Wake signal avoids the timeout; timeout fires; 300 unfinished steps continue as new with the goal ID retained. |
| Dummy and Codex turns | Transient activity failure retries and returns the expected result. |
| Supervisor, both branches | Enqueue/stop interrupts the child and queued mission; the 50-item boundary carries a pending turn and resumes it once; 250 one-second timers retain monitored missions, and the next run settles them exactly once without further polling. |
| Current supervisor | Stop/follow-up while preparing retires the stored run; prepared continuation survives rollover and completes its stored mission exactly once; an oversized queue drains without losing entries; allocation/send/verification finishes once; interrupted turns and reasons survive rollover; duplicate/malformed/foreign-room enqueues do not lose valid work. |
| Legacy supervisor | Boolean settlement removes the monitored mission without calling the new preparation activity. |
| Background action | Five exhausted attempts invoke the failure activity with the legacy workflow-ID fallback. |
| Memory maintenance/consolidation | Exhausted refresh/reconciliation failures do not prevent the real consolidation child; mutation retries and finalization still complete. |
| Memory mutation | Its own activity retries before returning success. |

Normal runs do not write fixtures. The final test requires an exact match between the complete `manifest.txt` and
the JSON files on disk: missing, renamed and unlisted fixtures fail the gate.
Manifest changes must be reviewed alongside a permitted recording; never remove
an old entry to hide a replay failure. It replays every listed file and reports failures with the filename
and workflow identity. It also asserts the SDK's `DeterminismViolationError` for
the intentionally incompatible test-only bundle. The recorder runs that same gate
after recording, so newly introduced fixtures are replayed in the same command.

The `Temporal sandbox and replay` CI job strictly type-checks the new tests and
their imported fixtures, then runs the entire worker suite independently
of the public-export provenance check. Its test step has a three-minute timeout;
dependency installation and package builds are separate steps. No test failure
is ignored. The GitHub ubuntu-latest duration must still be checked in CI: local
timings do not certify the runner budget. Tests use bounded waits and isolated
clocks; a passing replay gate covers the recorded histories, not every possible
execution.
