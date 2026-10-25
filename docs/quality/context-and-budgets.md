# Context, execution budgets and result evidence

Inventory of the remediation branch based on `b4029810ef` (plan package 6).
It is not a claim of live provider compaction or complete billing
verification. Space does not compact any conversation itself and does not layer
a second compactor over a provider's native one; where Space owns a
continuation it restates the recorded goal and constraints in the next message.

## Per-runtime context, accounting and continuation

| Runtime | Context owner | Token / cost data | Compaction | Continuation and recovery |
| --- | --- | --- | --- | --- |
| Native Chat and Dot conversations (Codex app-server stdio, `runCodexAppServerTurn`) | Codex native thread; Space sends only the new message and persists the thread ID | `thread/tokenUsage/updated` per-turn delta recorded as ledger usage `MEASURED`; cost `ESTIMATED` only with a versioned `SPACE_MODEL_PRICE_CATALOG`, otherwise `UNKNOWN` with the reason | Provider-native. Space never triggers it and has no handler for compaction notifications | Same native thread. Temporal retries (5 attempts) resume the checkpointed turn by recovery marker; a prompt is never resent |
| Codex native Goals (`thread/goal/*`) | Codex; Space sets the objective with `tokenBudget: null` and reads `tokensUsed` / `timeUsedSeconds` | Codex goal counters (read-only display) | Provider-native | Codex statuses `budgetLimited` / `usageLimited` / `blocked` end the Space turn as incomplete, not complete |
| Room Agent (Codex turns plus Space tool loop) | Codex thread for each turn; Space restates the complete operator request (up to 4,000 characters) and bounded evidence in every follow-up | As Native Chat, for the initial turn | Provider-native | Space-owned background continuation: a new turn per settled action batch carrying the request and cumulative action counts; bounded (see limits) |
| Managed plans (Codex CLI pane, app-server socket) | Codex thread in the pane; Space restates the immutable whole-plan text, stage criteria and latest checkpoint on every stage turn | None recorded (`providerTelemetry: false`) | Provider-native | One native turn per stage attempt; `START` is never resent, `SETTINGS` are idempotent and read back |
| Dots Goals (Space-driven steps in a Dot conversation) | The Dot conversation's provider thread; Space restates objective, every criterion and all guidance in each step message | Per-step run ledger (Codex measured usage) | Provider-native | Temporal `dotGoalWorkflow`; each step is idempotent by request key and reconciled after a crash |
| OpenCode HTTP chat (`runOpenCodeAgentTurn`) | OpenCode server session | The assistant message's counters (input, cache read/write, output, reasoning) are recorded as `MEASURED` ledger usage (`opencode:session/message`, model `providerID/modelID`); cost is estimated only when the price list has that model | Provider-native | Same OpenCode session; one attempt, bounded abort on failure |
| Broker CLI chat (`runCliAgentTurn`: Claude, Gemini, Qwen, Kimi, Grok, DeepSeek) | The provider CLI's native session | None; `UNKNOWN` | Provider-native | One attempt (a prompt send is not idempotent) |
| PTY CLI panes (16 runtimes) | `PROVIDER_NATIVE`, `spaceCompaction: NONE`, `usageReporting: UNAVAILABLE` (CLI adapter contract v1) | None at the PTY boundary; Codex rollout `token_count` events feed only the toolbar model statistics | Provider-native | Exact native resume for Codex, Claude, OpenCode, DeepSeek; provider selection or none for the rest ([runtime-compatibility.md](runtime-compatibility.md)) |
| Live voice delegation | Provider realtime session | Estimated cost from audit telemetry | Not applicable | Daily estimated budget (below) |

`packages/contracts/src/agent-run-ledger.ts` separates execution, startup model,
usage, cost and quality. Unknown cost has a null amount and a reason; an
estimate needs a price-catalog version and provenance and is labelled
"Estimated" in Task details. A thread counter is not a complete task bill;
provider dashboards remain separate evidence. Opaque providers are a stated
limitation: Space admits no token or cost budget where it has no trustworthy
usage.

## Limits

Defaults are unchanged unless marked **new**. Worker settings follow the worker
style (an absent or invalid value keeps the default); API settings are in the
configuration registry and fail fast on invalid input.

| Limit | Default | Configuration | Enforced at | When reached |
| --- | --- | --- | --- | --- |
| Managed plan native turns per stage (**new**) | 20 | `SPACE_PLAN_STAGE_MAX_ATTEMPTS` (1-1000, API) | `apps/api/src/plan-execution-controller.ts:315` before any settings or start command | Execution `FAILED`, `errorCode: PLAN_STAGE_ATTEMPT_LIMIT`, English `statusReason`, published `FAILED` event; no further turn; cannot be resumed |
| Managed plan model retry backoff | 1 s x 2^n, at most 5 min, honours Retry-After | Fixed | `plan-execution-controller.ts:109` | `WAITING_FOR_MODEL`; each re-sent stage turn now counts against the stage budget |
| Managed plan stage prompt | 20,000 characters | Fixed | `plan-execution-controller.ts:165` | `BLOCKED` before sending |
| Managed plan incomplete result | One correction | Fixed | `plan-execution-controller.ts:297` | `BLOCKED` |
| Room Agent supervision passes per turn | 8 | `SPACE_ROOM_AGENT_MAX_PASSES` (1-16, worker; **new** setting) | `apps/worker/src/activities.ts:1165` | Outcome `UNVERIFIED`; run `FAILED` with `errorCode: ROOM_AGENT_PASS_LIMIT`; mission `FAILED` |
| Room Agent constrained action repair | 1 | Fixed | `activities.ts:170` | `UNVERIFIED` (`BLOCKED:` reason) |
| Room Agent follow-up prompt | 8,000 characters, operator request kept first | Fixed | `activities.ts:169` | Evidence trimmed, request retained |
| Room Agent automatic continuations per operator request | 16 | `SPACE_ROOM_AGENT_MAX_CONTINUATIONS` (1-16, worker; **new** setting; the queue contract caps a generation at 16) | `apps/worker/src/room-background-continuation.ts:63` | Mission `FAILED` with `executionState.limit = { code: ROOM_AGENT_CONTINUATION_LIMIT, limit, continuationsUsed, reachedAt }` |
| Room Agent measured tokens per operator request | 10,000,000 | `SPACE_ROOM_AGENT_MAX_MISSION_TOKENS` (1,000-1,000,000,000, worker; `0` turns it off; **new** 2026-10-12) | `apps/worker/src/room-background-continuation.ts` (checked before each automatic continuation) | Mission `FAILED` with `executionState.limit = { code: ROOM_AGENT_TOKEN_LIMIT, limit, usedTokens, reachedAt }`; running total in `executionState.tokenUsage`, counted once per turn |
| Room Agent turn activity | 24 h, 5 attempts, 15 s heartbeat | Fixed | `room-supervisor-state.ts:3-5`, `workflows.ts:49` | Retry resumes the native turn; exhaustion fails the mission |
| Codex app-server turn session (Native Chat, Room Agent, Dots) | 240,000 ms | `SPACE_CODEX_APP_SERVER_TURN_TIMEOUT_MS` (5,000-2,400,000) | `activities.ts:437` | `CODEX_APP_SERVER_TURN_TIMEOUT`, session fail-closed |
| Native Chat activity horizon | 36,500 days | Fixed | `turn-runtime-policy.ts:5` | Termination comes from the per-turn session timeout, goal completion or cancellation |
| Broker CLI chat prompt / output / time | 32,768 bytes / 65,536 bytes / 900,000 ms; 30 min activity, one attempt | `SPACE_CLI_CHAT_TURN_MAX_PROMPT_BYTES`, `_MAX_OUTPUT_BYTES`, `_TIMEOUT_MS` | `activities.ts:2472-2474`, `workflows.ts:74` | `CLI_CHAT_TURN_OUTPUT_TOO_LARGE` and similar typed failures; owned child signalled |
| OpenCode chat message | 60,000 ms; 40 min activity, one attempt | `SPACE_OPENCODE_MESSAGE_TIMEOUT_MS` | `activities.ts:2160`, `workflows.ts:66` | Typed timeout, bounded abort request |
| Dots Goal steps / time | 20 steps (1-200) / 180 min (5-1440) | Per Goal (`budget`) | `apps/api/src/dot-goals.ts:187`, `packages/contracts/src/dot-goals.ts:69` | `BUDGET_EXHAUSTED` |
| Dots Goal consecutive failed steps | 3 | Fixed | `dot-goals.ts:186` | `FAILED` |
| Dots delegation | 8 steps (at most the parent Goal's remaining steps, else 50), 120 min | Per call | `apps/api/src/dot-delegations.ts:63,71` | Delegated Goal budget |
| Dots Goal step message | 7,900 characters; header, every criterion and the instruction are never cut (**fixed**) | Fixed | `packages/contracts/src/dot-goals.ts:85` | Older guidance, milestone detail, then the objective's tail are left out and named, with a pointer to `goal.status` |
| Dots Goal workflow | 300 iterations per run, history 10,000 events, then continue-as-new; step activity 20 attempts, 5 s to 2 min backoff (idempotent by request key) | Fixed | `workflows.ts:89-108` | Continue-as-new; the API decides completion |
| Room supervisor workflow | Continue-as-new after 50 turns or 250 polls; carried lists at most 100 | Fixed | `workflows.ts:262,379` | Continue-as-new once the carried state fits |
| Live voice delegation daily cost | Off | `SPACE_LIVE_DAILY_BUDGET_USD` (estimated) | `apps/api/src/app.ts:15790` | HTTP 429 `VOICE_DAILY_BUDGET_EXCEEDED` |

Confirmed gaps closed here: a managed plan stage that returned `CONTINUE`, kept
failing with a retryable error, or was repeatedly refused delivery started
native turns without any bound (the refused-delivery path at the 1 s scheduler
interval). The Room Agent limits existed but were fixed constants without a
regression test; they are now configurable with the same defaults and covered.

## Retries

Retries apply only to safe or idempotent work: Room Agent and Native Chat turns
resume a checkpointed native turn by recovery marker instead of resending;
mission bookkeeping activities write idempotent state; Dots Goal steps are
reconciled by request key; managed plan `SETTINGS` are read back before a
retry and `START` is never resent. Prompt sends without such a guard (broker
CLI chat, OpenCode chat) run exactly once.

## Verified-success semantics

- Chat/Dot runs: execution status and quality are separate. Declared
  acceptance checks are evaluated on the final text (`task-result-evaluation.ts`);
  a failed critical check is `SCORED` with `criticalFailure: true`; a missing
  result is `UNSCORABLE`; with no declared checks the ledger says no validator
  assessed the result. Task details show "Completed" with "Critical failure",
  never "Verified".
- Room Agent: a mission completes only from a `VERIFIED` outcome (verification
  block or fully evidenced orchestration); `UNVERIFIED`, including every limit
  above, fails the mission. **Fixed:** after one executed action with no
  active work (for example a single inspection), a prose-only "complete" claim
  was returned as `VERIFIED` even after the constrained repair, contradicting
  the prompt contract ("a prose-only response ... is never verified") and the
  existing regression "rejects prose-only completion", which failed on the
  base commit. It is now `UNVERIFIED` (`BLOCKED: ... after one constrained
  repair`). A turn that requests no action at all still completes as an
  informational answer.
- Room orchestration tasks (**fixed**): a task whose isolated quality
  evaluation failed (`LOW_QUALITY`) or produced no score was counted as success
  in the mission report and could make `completionVerified` true. Now
  `completionVerified` requires a score for every task and the report's
  percentage counts only verified tasks ("N% verified", with low-quality and
  not-evaluated counts). `completedTasks` still counts finished execution.
- Managed plans and Dots Goals: completion needs evidence for every criterion
  (and finished milestones for Goals); the evidence is model-reported and
  schema-checked, not independently verified.

## Proofs

Commands run from the app directory with
`TMPDIR=/var/lib/spaceapp-user/agent-workspace/t ../../node_modules/.bin/vitest run <file>`.

| Acceptance | Test | Result |
| --- | --- | --- |
| (a) Long session keeps checkable constraints | `apps/api/tests/dot-goal-long-session.test.ts` (**SIMULATED**: a fake thread keeps only the last two step messages verbatim, no summary; 12 steps, two guidance decisions, then the budget) | 3/3 pass; the previous builder failed: it lost the step-3 decision at step 5 and cut every criterion of a maximal Goal |
| (a) Plan and Room Agent continuations restate constraints | `apps/api/tests/plan-execution-budget.test.ts`, `apps/worker/tests/room-agent-limits.test.ts` | Every stage turn carries the plan constraint and latest checkpoint; every follow-up and continuation carries the operator request and totals for all 61 settled actions |
| (b) Runaway loop cut at the configured limit | `apps/api/tests/plan-execution-budget.test.ts` (CONTINUE forever, retryable failures forever, per-stage budget, default 20, configuration) | 5/5 pass |
| (b) | `apps/worker/tests/room-agent-limits.test.ts` (runaway agent at 3 passes and default 8; continuations at 3) | 4/4 pass |
| (b) | `apps/api/tests/dot-goals.test.ts`, `dot-goal-long-session.test.ts` | Budget, three failures, conversation closed |
| (c) Failed acceptance never verified success | `apps/worker/tests/task-result-evaluation.test.ts`, `apps/worker/tests/chat-task-run.test.ts`, `packages/contracts/tests/agent-run-ledger.test.ts`, `apps/web/tests/chat-task-details.test.tsx` | Failed critical check, missing result and missing checks are never scored success |
| (c) | `apps/api/tests/room-agent.test.ts` ("never reports low-quality or unevaluated task results as verified success"), `apps/web/tests/room-agent-dock.test.tsx` | API and UI payloads report 33% verified, not 100% |
| (c) | `apps/worker/tests/worker.test.ts` ("rejects prose-only completion and verifies a repeated completed inspection without re-executing it") | Failed on the base commit; passes with the fix |

Verification ran on a heavily loaded shared VM (load average 13-25). Typecheck
of api, worker and web against this checkout's package builds passed; the
domain-boundary ratchet passed. Failures also present on the base commit in a
detached baseline worktree and unrelated to this change: worker
`memory-maintenance`, `memory-consolidation-lifecycle` and
`codex-cli-completion` cases, and the API `config-registry` preflight case (three
`tsx` processes with a 10 s bound each). Under load, `room-agent.test.ts`
cases hit 90 s `afterEach`/`onReady` hook timeouts; all 23 cases were run in
focused groups with `--maxWorkers=1`: 22 pass, and "recovers a committed
unsignaled room mission once when a new API app starts" exceeds its own 20 s
test bound under this load, identically on the base commit. Runtime package tests import
`@space/contracts` through the shared `node_modules` (the live build); with an
alias to this checkout's contracts source, the plan execution store and outbox
tests pass 12/12.

The simulated proof shows that Space's restated step message preserves the
recorded goal, criteria and decisions even if a provider dropped all older
turns. It does not show how any real provider compacts; see Limitations for the one live
Codex compaction proof.

## Limitations

- Live provider compaction was observed once, on a short thread, not a long
  session: on 2026-10-12 an ephemeral Codex thread (`codex app-server`) learned a
  random code word, was compacted with `thread/compact/start` (item
  `contextCompaction`), and answered the code word correctly in the next turn
  (`scripts/codex-compaction-proof.mjs`, report
  `/var/lib/spaceapp-user/agent-workspace/reports/20261012-codex-compaction/proof.json`).
  Automatic compaction at the context limit and other providers were not observed.
- Usage is measured for Codex app-server turns and, since 2026-10-12, for
  OpenCode HTTP chat turns (cache reads count as cached input, reasoning as
  output). Broker CLI chat and PTY panes report none. The only token budget is
  the Room Agent's measured tokens per operator request: turns without a usage
  receipt count as zero, so it bounds measured spend, not total spend, and it
  stops further automatic continuations rather than interrupting a running turn.
  There is no per-turn or cost budget (besides the Live voice daily estimate);
  cost is an estimate from an operator price list.
- Room Agent missions have no wall-clock limit beyond per-turn timeouts; an
  operator follow-up starts a new continuation budget. Native Chat keeps its
  36,500-day activity horizon; each turn session is bounded.
- Space sets Codex native Goals without a token budget unless the operator sets
  `SPACE_CODEX_GOAL_TOKEN_BUDGET` (10,000-1,000,000,000 tokens; Codex then stops
  the Goal as `budgetLimited`).
- Plan and Goal completion evidence is reported by the model.
- Side effects a provider already performed are not rolled back when a limit
  stops further turns.
