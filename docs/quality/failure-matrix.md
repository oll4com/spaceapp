# Execution and recovery evidence matrix

All rows require the candidate source SHA, environment, injected fault, observed
state and command/result evidence. A deterministic fixture is not an upstream
provider or production proof.

**No exactly-once guarantee is claimed.** Temporal activities, signals and the
API recovery sweeps are at-least-once. Duplicates are prevented only where a
durable key or compare-and-set exists (named per row); where neither exists the
row says so. An ambiguous outcome is surfaced to the operator, never resolved by
an automatic resend.

Status key:

- **proven**: a deterministic test or real-infrastructure test listed in the row
  asserts the behaviour at this SHA.
- **fixed**: a defect was found and fixed on 2026-10-11 (plan package 2) or
  2026-10-12 (plan step 2, real-process proofs), with a test that fails before
  and passes after the fix.
- **limitation**: the behaviour is documented, but it is not guaranteed or not
  yet proven with a real runtime. The last column says what is missing.

## Required failure classes (plan package 2, 2026-10-11)

| Fault | Status | What holds | Evidence | Not guaranteed |
| --- | --- | --- | --- | --- |
| Worker crash or restart | proven (real SIGKILL and SIGTERM, disposable Temporal); fixed (single-attempt turns) | Workflow state survives worker processes: a new worker replays the history and continues. Codex turns (`maximumAttempts` 5, heartbeat 15 s) re-enter the same durable run, thread and turn on the next attempt and never send the prompt again. If the runtime interrupted the turn when its client died, the next attempt sends only the worker's recovery prompt on the same thread; if the runtime finished the turn, the next attempt reads the answer back and sends nothing. CLI chat and OpenCode turns (`maximumAttempts` 1, non-idempotent prompt send) are never retried. A graceful shutdown or an expired attempt records `INTERRUPTED`/`TURN_OUTCOME_UNKNOWN` with an explicit message (before the 2026-10-11 fix OpenCode left the run RUNNING forever and CLI called it an operator stop). After a hard kill no activity code runs: the attempt times out on its heartbeat, the workflow fails, and the API sweep (next row) fails the still-RUNNING run as an unknown outcome once its 180 s window has passed | Real processes: new `apps/worker/tests/worker-hard-kill.integration.test.ts` (3 cases, about 4 minutes; results in [Worker hard-kill proof](#worker-hard-kill-proof-on-a-disposable-temporal)). Live histories: see [Worker-restart evidence](#worker-restart-evidence-from-live-histories). Tests: `apps/worker/tests/worker.test.ts` "re-enters the same durable agent run after worker restart without sending the initial prompt twice", "propagates %s during a supervisor verification turn" (WORKER_SHUTDOWN, TIMED_OUT, CANCELLED); `apps/worker/tests/room-background-continuation.test.ts` "handles Temporal $reason for supervisor=$supervisor without confusing retry with STOP"; `apps/worker/tests/room-supervisor-continuation.test.ts` "persists background failure after Temporal exhausts execution retries, including legacy workflows"; `apps/worker/tests/single-attempt-turn-worker-shutdown.test.ts` (5 cases, 3 fail before the fix) | The providers were fakes (a Codex App Server script and an OpenCode HTTP server). Both ways a Codex runtime can treat a turn whose client died were modelled; neither was observed on the real binary. Not killed: Room Agent supervisor and child turns, CLI chat turns (their `sudo` broker spawn cannot be faked without root), a kill during the completion step after the provider answered, and a kill between `turn/start` and the turn ID checkpoint (marker recovery). No production worker was killed. There is still no TestWorkflowEnvironment test (`@temporalio/testing` is not installed). A single-attempt turn interrupted by a crash or restart is lost; the operator must resend it. After a hard kill its run stays RUNNING for up to about 5 minutes (180 s window plus the 2-minute sweep interval) |
| API stop after a persisted intent | proven; fixed (Chat sweep) | Room Agent: the request is committed with `signaled_at` NULL; API startup re-signals every unsignaled enqueue. A duplicate signal is absorbed: the supervisor ignores an `agentRunId` that is active or queued, and a turn whose outcome is already recorded returns that outcome instead of running again. Chat: a run committed QUEUED whose workflow never started is failed with "Retry it" after 180 s. A RUNNING Chat run whose workflow ended without an outcome is failed as unknown, never resent. Both are compare-and-set on the status and skip any run whose workflow Temporal still runs or cannot be asked. Managed plans and Dots Goals reconcile durable checkpoints on restart instead of resending | `apps/api/tests/room-agent.test.ts` "recovers a committed unsignaled room mission once when a new API app starts", "re-signals the same durable mission after an ambiguous coordinator failure", "does not re-signal a durable mission that already left the queue"; new `apps/api/tests/stranded-chat-runs.test.ts` (4 cases); new `packages/db/tests/execution-intent-postgres-restart.test.ts` "offers the stranded-run retry only for a Chat run whose workflow never started, never for a queued Room Agent turn" (failed before the fix); `apps/api/tests/plan-execution-recovery.test.ts` "restart reconciliation at %s checkpoint" (5 boundaries), "never resends a durable START with ambiguous acceptance after restart"; `apps/api/tests/dot-goals.test.ts` "reconciles a step submitted before a crash instead of rebuilding and resending it" | Recovery is at-least-once signal delivery plus workflow-side deduplication. The Chat sweep runs every 2 minutes, so a stranded run stays visible as QUEUED or RUNNING for up to about 5 minutes. A real API kill between commit and workflow start was not performed |
| Retry after a side effect | proven | Every retried side effect carries a durable identity checked before acting: the Codex turn's recorded thread/turn ID (no second `turn/start`), the room action's durable intent and CLI marker (no second write), the Dots tool call's arguments hash (unknown outcome is reconciled before an identical call runs), the memory change set journal, the Room Agent continuation ID | `apps/worker/tests/worker.test.ts` "re-enters the same durable agent run after worker restart without sending the initial prompt twice"; `apps/api/tests/room-actions.test.ts` "resumes monitoring a checkpointed CLI send without sending the instruction twice", "recovers a durable pre-send intent from marker-matched CLI activity without sending twice", "submits durable CLI content after recovery without writing the instruction twice", "sends an old durable intent once when no marker-matched CLI activity exists"; `apps/worker/tests/dot-tool-gateway.test.ts` "reconciles before repeating an identical change whose outcome is unknown, then lets the next attempt run"; `apps/worker/tests/memory-mutation-activity.test.ts` "reconciles a post-rename failure and leaves ambiguous state APPLYING"; `apps/worker/tests/room-supervisor-continuation.test.ts` "carries a prepared continuation through continueAsNew and starts it once" | Browser actions from a Chat reply carry no idempotency key: a transport failure is reported to the agent as failed ("unavailable or returned invalid data") although the action may have run, and nothing retries it. CLI chat/OpenCode prompts are never retried, by design. A retried Room Agent completion repeats its room-action request with the same `requestId`; the room-action executor's idempotency key (`apps/api/src/room-actions.ts`) returns the recorded result instead of executing again. A Codex Chat turn retried after its completion had already committed (lost COMMIT reply) runs the completion step again, including the reply's Space tool actions; that path was not tested |
| Lost acknowledgement | proven | A lost reply never causes a blind resend. PostgreSQL: a COMMIT whose acknowledgement is lost (proxy or real restart) is reconciled by the submission key or the upload journal. Temporal: a lost signal/start acknowledgement leads to a re-signal of the same durable item, absorbed as in the previous row. Activities: the committed outcome of a lost activity reply is read back instead of being produced again | `apps/api/tests/upload-record-postgres.integration.test.ts` "reconciles after dropping the server's %s acknowledgement" (COMMIT, INSERT); new `packages/db/tests/execution-intent-postgres-restart.test.ts` "a %s restart after the server committed but before the client saw COMMIT keeps one submission; the keyed retry replays it" (graceful, crash); `apps/api/tests/room-agent.test.ts` "recovers the original queued turn when Temporal acknowledgement is lost"; `apps/worker/tests/room-background-continuation.test.ts` "recovers the exact committed outcome after the completion activity reply is lost", "reuses the committed continuation after a lost activity reply"; `apps/api/tests/room-actions.test.ts` "keeps uncertain scheduler acknowledgement retryable with the same durable action"; `packages/cli-host/tests/ipc.test.ts` "preserves input idempotency across client reconnects" | Idempotency keys have no documented retention window; a Chat submission key is unique per pane for the life of its run row. `completeSpaceAgentRun` repeated with an unchanged response after a lost COMMIT reply records what it carries but returns the run's original `TURN_COMPLETED` event instead of appending a second one (fixed 2026-10-12, PostgreSQL test `chat-submissions-postgres.test.ts` and in-memory `space-agent-session-lifecycle.test.ts`); a completion that changes the response still announces itself |
| CLI exit | proven (host); limitation (real runtime) | The host reconciles a RUNNING session whose process died without a PTY exit event and terminates only the exact identified session. Exact native resume with a recorded session identity is declared for Codex, Claude, OpenCode and DeepSeek; nine runtimes only reach a provider continue/resume selection and three have none (`native-resume-matrix.md`) | `packages/cli-host/tests/session-registry.test.ts` "reconciles running sessions whose process died without a PTY exit event and counts them as cleaned", "sweep reconciles dead running sessions and prunes exited sessions past the retention window", "terminates only the exact identified CLI session", "rejects any immutable identity mismatch without attaching or replacing the session"; `packages/cli-host/tests/ipc.test.ts` "returns stable host error codes for identity mismatches and exact termination"; `apps/api/tests/cli-resume-launch-admission.test.ts` | No authenticated real CLI exit and resume with matching task, process and database identity was run in this pass. A CLI chat turn whose child process exits without output fails with `CLI_CHAT_TURN_FAILED` and is not retried |
| Network interruption | proven | API to CLI host: the transport detaches without killing the PTY, output is replayed by monotonic sequence and input is deduplicated by ID across reconnects. API to Browser Host: typed unavailable error, request timeout drops the socket, reconnect on the same socket after a host restart; a browser viewer socket (frames or audio) whose stream died with a restarted or unreachable host is closed (1012 "Browser Host restarted" or 1011) and the page reconnects with a fresh ticket to a stream from the live host (2026-10-27). Worker to API: a cut room-action request leaves the activity retryable (the API deduplicates it). API to PostgreSQL: see the PostgreSQL row | `packages/cli-host/tests/ipc.test.ts` "serves the protected Unix socket contract and detaches transport without killing the PTY", "preserves input idempotency across client reconnects"; `packages/cli-host/tests/session-registry.test.ts` "replays monotonic output after reconnect without gaps or duplicate sequences", "deduplicates identified input in the independent host across API attachments"; `packages/browser-host/tests/ipc.test.ts` "returns a typed error when the Unix socket is unavailable", "times out when a connected host never responds", "reconnects after the Browser Host restarts on the same socket", "drops the socket after a request timeout so the next request reconnects"; `apps/worker/tests/worker.test.ts` "propagates a transient room action bridge outage so Temporal can retry after an API restart", "leaves a room-agent activity retryable when its internal action request is cut by an API restart"; `apps/web/tests/browser-pane.test.tsx` "fetches a fresh one-time stream ticket before reconnecting and never replays timed-out input through REST"; `apps/api/tests/browser-realtime-stream.test.ts` "closes the viewer socket when the Browser Host restarts, so the page reconnects to the new host" (fails before the fix); `apps/api/tests/browser-stream-host-watch.test.ts` (4 cases); the host-crash case of `apps/api/tests/browser-chrome-crash.integration.test.ts` | Browser-to-API WebSocket recovery of a CLI pane with an unchanged native ID and PID has no authenticated proof in this pass. Arbitrary packet loss and partitions were not injected |
| PostgreSQL restart | proven; fixed (masked error, pool listeners) | Real disposable server, every migration applied, graceful (`docker restart`) and crash (SIGKILL, WAL recovery) restarts. Inside an open Chat submission transaction: the caller gets the connection error, nothing of the intent survives (messages, run, session status), and the keyed retry creates exactly one run and then replays it. After the server committed but before the client saw COMMIT: exactly one run and both messages are durable, and the keyed retry returns that run. The original error (57P01 on a graceful restart) now reaches the caller instead of the ROLLBACK error, and the canonical-memory pool no longer raises an unhandled `error` | New `packages/db/tests/execution-intent-postgres-restart.test.ts` (6 cases, about 45 s); restart support in `packages/db/tests/support/disposable-postgres.ts`; details in [postgres-proofs.md](postgres-proofs.md#restart-during-execution-intent) | Only the Chat submission and stranded-run paths were exercised under restart; other store transactions rely on the same `withTransaction` but were not individually restarted. Production RPO/RTO: see `restore-and-migrations.md`. Physical storage loss is out of scope |
| Browser crash | proven (real Chrome); fixed (stale stream slot, tabs lost in a crashed navigation) | A Chrome browser process killed with SIGKILL is replaced by the next request to its pane (about 1 s). That request reloads the active URL and recreates the background tabs, and the dead stream's live-stream slot is released. A stream handle from before the crash can no longer release the replacement stream's slot. A request that races the crash fails once, within milliseconds, with `BROWSER_HOST_INTERNAL_ERROR` ("Chrome DevTools Protocol socket closed."). A CDP call in flight when Chrome dies fails within 0.1 to 0.5 s instead of hanging until the 30 s host timeout. A crash during a navigation keeps the background tabs; the uncommitted target is not reloaded and the active page comes back blank. Browser sessions restore the active URL and unique tabs after a host restart; an interrupted capture segment fails and the next starts at the next sequence. A hung handler cannot block later requests | Real Chrome: new `apps/api/tests/browser-chrome-crash.integration.test.ts` (3 cases, `/usr/bin/google-chrome` 150.0.7871.114 under Xvfb, about 35 s; results in [Real Chrome crash proof](#real-chrome-crash-proof)). New unit tests, both failing before the fix: `apps/api/tests/browser-account-profiles.test.ts` "keeps the replacement stream slot when a stream handle from before the crash stops late", `apps/api/tests/browser-sessions.test.ts` "keeps the background tabs, but not the active page, when Chrome restarts during a navigation". Existing: `browser-account-profiles.test.ts` "releases stale streaming capacity when a crashed profile is recovered"; `browser-sessions.test.ts` "restores the active URL and unique background tabs after a host restart", "fails an interrupted open segment and resumes after restart at the next sequence"; `browser-runtime-lifecycle.test.ts` "closing during startup waits for and stops that process without reviving the session"; `packages/browser-host/tests/ipc.test.ts` "times out a hung server handler request without blocking later requests on the same socket" | Nothing watches Chrome: a crash is noticed only by the next request, and viewers of a stream that died with Chrome get no end signal until then (the live view moves to the replacement Chrome). A viewer of a stream that died with the Browser Host process is ended by the API within about 5 s (Network interruption row). Through the API proxy the racing request reads "The Browser Host is unavailable". CDP commands have no per-command timeout, so a Chrome that is alive but stalled is bounded only by the 30 s host request timeout. Only one pane without a Google or shared account profile was crashed, through the IPC client; the API routes and the WebSocket viewer were not in the loop. Unsaved page state (form input, scroll position, in-page JavaScript state) is lost |
| Pause, cancel and recovery | proven | Room Agent missions pause and resume the same goal without a new mission; stop interrupts active and queued work even when the Temporal stop signal fails; a stop committed between read and write wins over completion. Cancelled CLI turns never spawn a process. Managed plans pause only after closing evidence and resume with a fresh command; Dots Goals pause, resume and cancel with the current run interrupted | `apps/api/tests/room-agent.test.ts` "pauses and resumes the same goal without creating another mission", "signals the durable supervisor to stop active and queued work", "blocks local room actions even when the Temporal stop signal fails", "invalidates a paused completion checkpoint when a new follow-up extends the goal"; `apps/worker/tests/room-background-continuation.test.ts` "does not prepare after %s while monitoring" (PAUSED, INTERRUPTED), "guards completion against stop committed between read and write"; `apps/worker/tests/room-supervisor-continuation.test.ts` "retires a prepared run when %s arrives before the activity reply"; `apps/worker/tests/cli-chat-output-budget.test.ts` "does not launch a cancelled turn %s"; `apps/api/tests/plan-execution-recovery.test.ts` "pause closes evidence before PAUSED; restart stays idle and explicit resume uses a fresh command"; `apps/api/tests/plan-execution-controller.test.ts` "pauses an interrupted native turn without restarting it"; `apps/api/tests/dot-goals.test.ts` "pauses, resumes and cancels with the current run interrupted"; `apps/worker/tests/dot-goal-loop.test.ts` "waits long while paused and briefly while waiting for approval or capacity, without observing runs" | Cancellation of a running CLI or OpenCode turn is best effort (SIGTERM, then the server-side abort request); work the runtime already did is not undone. Not proven with real supported runtimes in this pass |

## Other rows

| Fault | Status | Evidence | Remaining acceptance |
| --- | --- | --- | --- |
| API transport loss | proven (host) | CLI host IPC/session registry reconnect, replay and input deduplication tests (Network interruption row) | Authenticated real CLI execution, WebSocket recovery, unchanged native ID/PID |
| Host unavailable or restarted | proven (IPC) | Browser host IPC typed-error, timeout and same-socket reconnect tests; a real Chrome process crash under the host is proven (Browser crash row) | Real Browser Host process crash with recovered state |
| Disconnected Control client | proven (deterministic) | Operation remains pending until acknowledgement; 89 related control/decision tests pass | Real browser disconnect and acknowledged reconciliation |
| Competing CLI replacement | proven (deterministic) | Approved HTTP lease guard; 11 protocol-v2 control tests and three reconnect/start checks pass | Authenticated browser conflict and session continuity |
| History purge rollback | proven (synthetic) | 23 synthetic SQLite regressions, including optional artifact rows, concurrent changes and byte-exact restore | Real application backup/restore; no operator history was modified |
| Memory write interrupted | proven (deterministic) | Memory mutation executor journal recovery, locking and rollback tests; concurrency on disposable PostgreSQL (`packages/db/tests/memory-concurrency-postgres.test.ts`) | Isolated filesystem/DB coordinated crash and recovery |
| PostgreSQL transaction retry | proven | Migration runner retries 40001/40P01 and rejects unrelated errors; `withTransaction` retries only deadlocks where a caller opts in | A connection error is never retried inside the store; the caller or Temporal retries the whole operation |
| Replay determinism | proven for retained types | See [Replay determinism check](#replay-determinism-check-core-006) | `roomAgentActionWorkflow`, `dotGoalWorkflow`, `dummyTurnWorkflow` and `memoryMutationWorkflow` had no retained history, so their replay is unproven. The check is manual, not part of deploy or CI. Replay proves only that the command sequence is compatible |
| Managed plan controller | proven (deterministic) | Not a Temporal workflow: an in-API controller with lease fencing and a jsonb event cursor. `apps/api/tests/plan-execution-controller.test.ts` "does not send from an expired worker after another controller claims its lease"; `apps/api/tests/plan-execution-recovery.test.ts` lost-ACK, pause, override and restart cases, including "explains restart uncertainty without exposing runtime text or suggesting an unsafe resend". Retries back off to 5 minutes and only read the model list (CTX-004) | Real controller restart during a native turn with unchanged thread identity |
| Backup/restore | proven (synthetic); limitation | See `restore-and-migrations.md` (daily logical backups, RPO at most 1 day while the timer runs, measured restore drill RTO) | Application/filesystem restore, production scale, concurrent writes, native continuation and supported upgrades |
| Warm rooms | out of scope | Protected architecture preserved by scope | Authenticated retention beyond 35 seconds, six rooms/96 panes and unresolved large-workspace warm gate |

Any real proof must use the mandatory single owned Agent Proof room and clean up
its temporary panes/room. An open pane or RUNNING status alone is not execution
evidence. Credentials and user transcripts must not enter the evidence bundle.

See [postgres-proofs.md](postgres-proofs.md) for measured fixture conditions,
reproduction and exclusions.

## Worker-restart evidence from live histories

Every deploy restarts `space-worker.service`. On 2026-10-11 a read-only script
listed every execution in the live namespace's 1-day retention window and
fetched its history (list and history fetch only; nothing was started,
signalled or terminated). Two independent restart signals were used:
`journalctl -u space-worker.service` STOP/START windows, and the worker identity
(`pid@host`, hashed) recorded on each `WorkflowTaskCompleted` event: a change
of identity means the workflow continued on a new worker process after a
replay. The redacted count-only summary and the runner are outside the
repository in `/var/lib/spaceapp-user/agent-workspace/reports/20261011-failure-matrix/`
(`worker-restart-evidence.json`, `worker-restart-evidence.mjs`).

Snapshot at 14:21Z:

- **Restarts:** 64 `space-worker` restarts in the retained journal (from 04:52Z). Every stop was graceful ("Deactivated successfully"); none was killed.
- **Executions:** 102 retained: 62 open `roomAgentSupervisorWorkflow`, 38 `codexAppServerTurnWorkflow` (36 completed, 2 cancelled), 1 `memoryMaintenanceWorkflow`, 1 `memoryConsolidationWorkflow`.
- **Resumed:** 28 executions continued on a new worker process after a restart. 27 of the 62 open supervisors did so 72 times in total, 8 of those with a child turn workflow in flight; all 27 are still RUNNING. One turn workflow had its `runCodexAppServerTurn` activity in flight when the worker stopped. Its cancellation arrived inside the 31 s restart window. The sticky workflow task timed out (`SCHEDULE_TO_START`), and the new worker replayed the history and completed the cancellation (CANCELLED). The activity attempt was abandoned with the workflow, not retried.
- **Failed because of a restart:** 0. There were 0 `WorkflowTaskFailed` events (no nondeterminism) in any retained history. There were 5 workflow-task timeouts (4 `SCHEDULE_TO_START`, 1 `START_TO_CLOSE`), one of them inside a restart window.
- **Activity retries:** 1 retried activity in the window (`discardRoomAgentSupervisorTurn`, attempt 2 after `SpaceNotFoundError`, completed). No turn activity was retried after a restart, so activity re-entry is proven only by the worker tests above.

What this does not show: a hard kill (SIGKILL or power loss) of the worker, an
activity retried on a new worker in production, or any CLI chat/OpenCode turn
interrupted by a restart (none ran across one in the window). A hard kill, a
graceful stop and an activity retried on a new worker process are shown on a
disposable Temporal in the next section; production still has neither.

## Worker hard-kill proof on a disposable Temporal

Run on 2026-10-12 at source `4e37146001` plus the test (commit `b4097a8b99`; no
change under `apps/worker/src` or `packages/`), on the loaded VM:

```sh
cd apps/worker && TMPDIR=<owned scratch dir> npx vitest run tests/worker-hard-kill.integration.test.ts --maxWorkers=1
# SPACE_WORKER_KILL_EVIDENCE=<file> also writes the redacted JSON summary
```

- **Setup:** `temporalio/auto-setup:1.29.1` and `pgvector/pgvector:0.8.3-pg17-trixie` run on a task-owned Docker bridge network with unique names. The test reaches Temporal at its bridge address and PostgreSQL through a bind-mounted Unix socket (no published ports). Every Space migration is applied. The worker uses its own namespace and task queue.
- **Worker:** the unchanged entry point `apps/worker/src/worker.ts`, started as its own process from the checkout's TypeScript sources by `scripts/test-support/worktree-source-loader.mjs`. The test asserts that every `@space/*` import resolved inside the checkout. The workflow bundle is built from the same sources.
- **Environment:** explicit; nothing is inherited from the calling shell, and every path or endpoint with a live default points into the run's directory. `SPACE_PG_SOCKET_PATH` must name the disposable socket, because `createSpacePgPool` otherwise prefers the live PostgreSQL socket whenever it is reachable.
- **Turns:** persisted with the store's Chat submission method and started with the API's `TemporalCodexAppServerTurnStarter`, as `sendMessage` does.
- **Providers:** `apps/worker/tests/support/fake-codex-app-server.mjs` speaks the stdio JSON-RPC subset the worker uses and keeps thread state and a ledger of every `turn/start` under its `CODEX_HOME`. The OpenCode server is an HTTP fake in the test that records every request and never answers a prompt. No model is called.

Results:

- **SIGKILL** with three turns in flight (both Codex turn IDs checkpointed, the OpenCode prompt posted). The worker exited on signal SIGKILL; the replacement worker was polling 6.1 s later.
  - Codex turn whose runtime interrupted the turn when its client died: attempt 2 started on the new worker 16.6 s after the kill (last failure: heartbeat timeout) and resumed the same thread. It sent the worker's recovery prompt once; the original prompt was sent once in total. The run COMPLETED on the same thread with one run, two messages and one `TURN_COMPLETED` event.
  - Codex turn whose runtime finished the turn after its client died: attempt 2 read the finished turn back and sent nothing (one `turn/start` in total). The run COMPLETED with the original turn ID and the runtime's answer.
  - OpenCode turn (`maximumAttempts` 1): the attempt timed out on its heartbeat 15.6 s after the kill and the workflow FAILED; there was no retry. OpenCode received one prompt and no request at all after the kill, not even the abort. The run, reply and session stayed RUNNING.
- **SIGTERM** (graceful stop) with a Codex and an OpenCode turn in flight. The worker exited with code 0 after 30.1 s.
  - OpenCode recorded `INTERRUPTED`/`TURN_OUTCOME_UNKNOWN` itself and asked OpenCode to abort; its workflow failed without a retry.
  - The Codex turn recorded nothing. Attempt 2 on the next worker (last failure "Worker is shutting down and this activity did not complete in time") sent the recovery prompt and completed.
- **API sweep:** the real `sweepStrandedChatRuns` with `PostgresDotsRepository` and the API's Temporal `describe()` lookup. A sweep inside the 180 s window changed nothing. After it, the SIGKILLed OpenCode run became `FAILED`/`SPACE_AGENT_RUN_OUTCOME_UNKNOWN`, its reply FAILED and its session READY, 180.8 s after the kill. A second sweep changed nothing, and the other five runs kept their outcomes.
- **Cleanup:** no process with the run's directory was left; the containers, network and directories were removed.

The limits are in the Worker crash or restart row.

## Defects fixed on 2026-10-11 (plan package 2)

1. **The stranded-run sweep failed queued Room Agent turns.** A Room Agent turn is QUEUED in its supervisor queue, and its child workflow does not exist until the supervisor reaches it. The Chat sweep therefore failed it after 3 minutes with "did not start", and the supervisor then skipped it, so the operator's request was lost. `listStaleQueuedRuns` now excludes runs owned by a Room Agent request.
2. **A dead single-attempt turn stayed RUNNING forever.** An OpenCode turn interrupted by a worker shutdown recorded nothing, as if a retry would follow, but it runs with `maximumAttempts` 1. Its run, response and session stayed RUNNING forever, and the pane rejected new requests. The CLI chat turn recorded the same event as an operator stop. Both now record an unknown outcome. The API sweep fails RUNNING runs whose workflow has ended without an outcome; this covers hard kills, where no activity code runs.
3. **The original PostgreSQL error was masked.** On a lost connection, `withTransaction` threw the ROLLBACK error, so 57P01 became "Client has encountered a connection error and is not queryable". The original error is now kept, and the broken client is destroyed rather than returned to the pool.
4. **The canonical-memory embedding pool had no error listeners.** A PostgreSQL restart terminating its idle client raised an unhandled `error` event, which ends the API process when canonical memory search is enabled.

## Real Chrome crash proof

Run on 2026-10-12 with the fix (commit `1616f268bf`); values before the fix are
given where they differ. Setup took about 8 s, the three cases about 26 s.

```sh
cd apps/api && TMPDIR=<owned scratch dir> npx vitest run tests/browser-chrome-crash.integration.test.ts --maxWorkers=1
# SPACE_CHROME_CRASH_EVIDENCE=<file> also writes the redacted JSON summary
```

- **Host:** the unchanged `apps/api/src/browser-host-main.ts`, started from the checkout's sources (`scripts/test-support/worktree-source-loader.mjs`) as its own process group. It has its own Unix socket, profile root and explicit environment, and uses a disposable PostgreSQL (`packages/db/tests/support/disposable-postgres.ts`, every migration).
- **Browser:** Xvfb `:100` and `/usr/bin/google-chrome` (google-chrome-stable 150.0.7871.114-1), with the production launch flags.
- **Client:** the API's IPC client, `BrowserHostClient`, against a local fixture origin set as `SPACE_BROWSER_EVIDENCE_TARGET_ORIGIN`. The test SIGKILLs the pane's Chrome browser process, found by its `--user-data-dir` under the profile root and its parent PID.
- **Short TMPDIR:** Chrome aborts at startup when its singleton socket path (`$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket`) exceeds the Unix socket limit, so the host gets a short TMPDIR. Production uses PrivateTmp `/tmp`.

Results:

- **Crash with one live stream:**
  - A request racing the kill (`captureFrame`, before the host reaped Chrome) failed after 23 ms with `BROWSER_HOST_INTERNAL_ERROR`, "Chrome DevTools Protocol socket closed.".
  - The next request (`listPages`) started a new Chrome in 0.96 s and reloaded `/a` as the active page. It also recreated `/b` in the background; that tab finishes loading after the response.
  - Capacity afterwards: 1 session, 0 live workloads. The dead stream received no frame and no end signal after the kill.
- **Stream handle from before the crash:** with a new stream running on the replacement Chrome, stopping the old handle left 1 live workload, and the new stream kept sending frames. Before the fix it left 0 live workloads while the stream ran.
- **Crash during a navigation** (to a page that never answers):
  - The in-flight `navigate` failed 86 ms after the kill (before the fix 158 ms) with `BROWSER_HOST_INTERNAL_ERROR`, not after the 30 s host timeout.
  - The session row stayed NAVIGATING, with `/a` as its current URL and the unanswered page as its target.
  - The next request replaced Chrome in 2.2 s and recreated the background tab `/b`; the uncommitted target was not requested again. The active page came back blank, and the next frame moved the row to READY with no current URL. Before the fix only the blank page came back: `/b` was lost.
- **Cleanup:** the host stopped on SIGTERM with exit code 0. No process was left in its process group or with the profile root.
- **Viewer across a Browser Host crash** (2026-10-27, run from the worktree of the change): a frame stream started through the API's own host proxy (`createBrowserHostProxy`, the shared client) with the stream host watch at a 250 ms interval. The whole host process group was SIGKILLed; the watch ended the viewer 381 ms after the kill (reason `unavailable`: two failed health reads while no host listened; the new host listened 1.2 s after its start). The reconnect's new stream on the new host sent its first frame after 521 ms, with 1 live workload, and 0 after its stop. Before the fix the viewer kept its socket and got no frame and no end signal. In production the watch reads every 5 s (`SPACE_BROWSER_STREAM_HOST_WATCH_MS`), so a systemd restart (about 1.4 s) usually shows as a new host identity (`restarted`, close 1012).

## Defects fixed on 2026-10-12 (plan step 2)

5. **A stale stream handle released the replacement stream's slot.** After a Chrome crash, `launchRuntime` releases the dead stream's live-stream slot. When a viewer started a new stream on the replacement Chrome before the old viewer went away, stopping the old handle released the slot again. That slot now belonged to the new stream, so capacity counted 0 live workloads while a stream ran, and one stream more than `maxLiveWorkloads` could start (not exercised). A handle of a runtime that is no longer the session's current runtime now leaves the slot alone.
6. **A crash during a navigation lost every background tab.** `navigateSession` marks the session NAVIGATING before it starts Chrome and navigates. If Chrome died first, the row stayed NAVIGATING, and the relaunch restored nothing. The same happened when a navigation was the first request after a crash. The next page refresh then overwrote the saved tabs. The navigation still owns the active page, and its uncommitted target is never reloaded, but the background tabs are now restored.

## Status at 2026-10-27

The browser-to-API stream path under a Browser Host restart is closed: the API's
stream host watch (`apps/api/src/browser-stream-host-watch.ts`, one shared health
read of the host's pid and start time while any viewer is open) ends viewers whose
host stream died, and the page's existing reconnect takes a stream from the live
host. Still missing for CORE-001: an authenticated real CLI exit and resume on live
with matching task, process and database identity, and an authenticated proof of a
CLI pane's terminal WebSocket recovery with an unchanged native ID and PID.

## Status at 2026-10-12

A hard worker kill and a graceful stop are proven on a disposable Temporal with
the real worker code, and a real Chrome crash under the real Browser Host
(CORE-001, CORE-006, CORE-007). Two browser defects are fixed. Still missing:
time-skipping workflow tests, a real Codex App Server or CLI chat runtime in
the kill proof, a Browser Host process crash, and authenticated real-runtime
proofs.

## Status at 2026-10-11 (v2)

Exact native resume with a recorded session identity is declared and tested for
Codex, Claude, OpenCode and DeepSeek. Nine runtimes reach only a provider
continue/resume selection, and three have no native resume (ADAPTER-006). The
readiness probe now checks the database and separates liveness (OBS-010).
The Room Agent supervisor's continuation input bound is enforced before
continueAsNew (CORE-008). Replay determinism against the retained live histories
is checked (CORE-006, partial). Worker restarts are evidenced from live
histories, PostgreSQL restarts by a disposable-server test, and four
reconciliation defects are fixed. Time-skipping workflow tests, a hard worker
kill and authenticated real-runtime proofs are still missing.

## Replay determinism check (CORE-006)

Run it before deploying a change to workflow code:

```sh
node scripts/temporal-replay-check.mjs                  # src: apps/worker/src + packages/*/src
node scripts/temporal-replay-check.mjs --source dist    # built apps/worker/dist, production resolution
node scripts/temporal-replay-check.mjs --type roomAgentSupervisorWorkflow --limit 100
```

- **Defaults:** `SPACE_TEMPORAL_ADDRESS`/`SPACE_TEMPORAL_NAMESPACE`, otherwise `127.0.0.1:7233`/`default`, the same as the API and worker. The check takes open executions first, at most 50 per type and 200 in total.
- **Read-only:** it calls only list, count, system-info and history fetch. Replay runs in an offline replay worker.
- **Output:** a JSON summary of counts per type, sanitized workflow IDs and error class names. Payloads, inputs, results and error messages are never printed or saved.
- **Exit codes:** 1 means nondeterminism, 3 another replay failure, 2 a setup error.
- **Agent sandboxes:** agent shells on public-host run in their own network namespace, where `127.0.0.1:7233` is closed. Use the `space-temporal-1` container's current Docker address (`docker inspect space-temporal-1`); it was `172.18.0.5` and later `172.18.0.3`.

Results:

- **3dd913eb48 (first run):** 85/85 retained histories passed in src and dist modes, 26,133 events, 0 nondeterminism and 0 other replay errors. The histories were 62 open `roomAgentSupervisorWorkflow` (28 pre-patch on the legacy branch, 34 with the `room-background-continuation-v1` marker), 21 closed `codexAppServerTurnWorkflow`, 1 `memoryMaintenanceWorkflow` and 1 `memoryConsolidationWorkflow`. Negative control: a timer injected into a scratch copy of `codexAppServerTurnWorkflow` failed 21/21 with `DeterminismViolationError` (exit 1). 11 offline `node --test` cases cover parsing, redaction, registry coverage and the read-only guard.
- **9b9a5198d2 (rerun after the failure-matrix fixes, no workflow code change):** `--limit 50`, src mode, 15:19Z. 90/90 histories passed, 25,050 events, 0 nondeterminism, 0 replay or fetch errors. The 90 were 50 of the 62 open `roomAgentSupervisorWorkflow` (the per-type limit), 34 of them with the patch marker; all 38 retained `codexAppServerTurnWorkflow`; 1 `memoryMaintenanceWorkflow`; and 1 `memoryConsolidationWorkflow`. The run took 28.5 minutes on the loaded VM.
