# Workflow history fixtures (replay determinism gate)

These are synthetic Temporal workflow histories recorded from the real
workflow code on the time-skipping test server with fully stubbed
activities. They contain no real rooms, missions or memory state. The
replay gate (tests/temporal-sandbox/replay-gate.test.ts) replays every
history through Worker.runReplayHistories, so any change to a workflow
that is not replay compatible fails CI with DeterminismViolationError.

There must be at least one history per workflow plus one recorded from
the pre-patch supervisor branch (no room-background-continuation-v1
marker), which replays the legacy code path kept for old histories.

## When to re-record

Re-record only when a workflow legitimately changes its command sequence,
for example after shipping a new patched() change. Run:

    npm run temporal:record-histories -w @space/worker

Never re-record just to make a failing replay pass - that is exactly the
class of non-deterministic workflow change this gate exists to catch. If
a replay fails, fix the workflow code (usually by guarding the change
with patched()) or record the pre-change history under a new fixture name
instead of overwriting the old one. The recording command writes only its
fixed fixture names. Before re-recording, copy the affected pre-change JSON
to the new name, then add that name to EXPECTED_FIXTURES in
tests/temporal-sandbox/replay-gate.test.ts and to the expected list in
tests/temporal-sandbox/record-histories.test.ts.
