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
| Broker CLI chat (`runCliAgentTurn`: Claude, Gemini, OpenCode, Qwen, Kimi, Grok, DeepSeek, Cursor, Copilot, Autohand, Hermes) | The provider CLI's native session | Claude records native per-turn ledger usage through a versioned usage-only stderr receipt (launcher installed; live receipt proof pending). OpenCode broker source now has the same receipt boundary, pending operator promote/live proof; its HTTP route is separate. Gemini has the same receipt from Antigravity's JSON result (`gemini-cli:result`, 2026-11-03; its live receipt waits for the guarded wrapper activation). Qwen has it from Qwen Code's JSON result (`qwen-cli:result`, 2026-11-04; same wait). DeepSeek has it from Reasonix's run summary (`deepseek-cli:metrics`, 2026-11-04; same wait). Kimi has it from its own session log (`kimi-cli:usage.record`, 2026-11-04; same wait). Copilot has it from its own session log (`copilot-cli:usage_record`, 2026-11-04; same wait). Hermes has it from its own `-z --usage-file` report checked against its session row (`hermes-cli:usage-file`, 2026-11-04; same wait). Old wrappers and other runtimes remain `UNKNOWN` (dev disables broker turns). The Token usage page counts Claude runs (`agent-chat` keeps its transcript; through Space Gateway they come from its request logs, tagged `agent-chat`) and every runtime on Space Gateway, DeepSeek (Reasonix) sessions on their own keys from each session's counters (`--deepseek-history`, CTX-001) Qwen Code sessions from Qwen's own usage log (`--qwen-history`, CTX-001) and Grok sessions from each session's `usage.json` with xAI's cost (`--grok-history`, CTX-001); Kimi native subscription calls gain the same page importer (`--kimi-history`, 2026-11-04; helper activation awaits stable promotion, custom/OpenAI-compatible routes excluded; see below) | Provider-native | One attempt (a prompt send is not idempotent) |
| PTY CLI panes (16 runtimes) | `PROVIDER_NATIVE`, `spaceCompaction: NONE`, `usageReporting: UNAVAILABLE` (CLI adapter contract v1) | None at the PTY boundary. The Token usage page (`apps/api/src/token-usage-sources.ts`) counts Claude Code transcripts of every profile and Codex rollout `token_count` turns (root-owned helper `space-cli-token-usage`, stable only) and every request through Space Gateway (Gemini and Copilot on its profile, OpenCode, Oh My Pi, Hermes, Droid and Qoder on its Claude API key) DeepSeek (Reasonix) sessions on their own keys (the same helper's `--deepseek-history`: each session's cumulative `telemetry.json` counters) and Qwen Code sessions (`--qwen-history`: Qwen's `usage_record.jsonl`, per session and model; none while Qwen runs through a Space Gateway pool) Grok sessions (`--grok-history`: each session's cumulative `usage.json`, per model, with xAI's reported cost) and GitHub Copilot sessions (`--copilot-history`: Copilot's per-call `session.usage_record` events in each session's `events.jsonl`, summed per model, no price; its BYOK calls are Space Gateway's) and Autohand sessions on its own OpenRouter key (`--autohand-history`: each session's cumulative `metadata.json` usage total, only those Autohand marks `actual`, no cached split, no price) and Kimi native subscription calls (`--kimi-history`: matched `llm.request`/`usage.record`, main agents and subagents, cache read/write preserved, no price; helper activation awaits stable promotion); other runtimes on their own accounts off the Gateway are not counted | Provider-native | Exact native resume for Codex, Claude, OpenCode, DeepSeek; provider selection or none for the rest ([runtime-compatibility.md](runtime-compatibility.md)) |
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
  Automatic compaction at the context limit was observed live on 2026-11-03 in the
  pane transcripts' metadata (counts and token figures only; script and results in
  `/var/lib/spaceapp-user/agent-workspace/reports/20261103-ctx-001-compaction/`): Claude Code
  recorded 643 `compact_boundary` entries, all `trigger: auto`; the 558 since the
  400k auto-compact window (`CLAUDE_CODE_AUTO_COMPACT_WINDOW`, 1/11) compacted at a
  median of 367,393 tokens, the 85 before it at 967,794 on the 1M window. Codex
  recorded 82 `compacted` entries, 79 at 200k input or more, median 258,669 against
  `model_auto_compact_token_limit = 258000`. That a pane kept its task across one is
  shown only for the short Codex thread above.
  Qwen Code panes were measured the same way on 2026-11-03 (chat metadata and Qwen's own
  `usage_record.jsonl`, counts only; `/var/lib/spaceapp-user/agent-workspace/reports/20261103-ctx-001-qwen/`):
  none has compacted. Qwen 0.20.0 records a compaction as a `system`/`chat_compression`
  entry with its token counts and `triggerReason` (`token_limit` when automatic), and
  compacts automatically at min(0.85 × window, window − 33,000) tokens (167,000 on its
  200,000 default; Space sets no `contextWindowSize` or `autoCompactThreshold`). The 295
  chat files (22/7-3/11) hold no such entry and 33 answered turns, the largest prompt
  31,884 tokens. The usage log's 247 sessions recorded input tokens only in 27, the last
  on 2026-09-18; every session since recorded none (its OpenRouter key answers 402 for
  credits), so a Qwen pane cannot reach the threshold until its provider serves turns.
  Cursor, Muse and the Harness keep no local usage records; they were not observed. Kimi Code 2.4.1 does keep them
  (`usage.record` events in each session's `wire.jsonl`, 2026-11-04, CTX-001), not observed at its threshold either.
- Usage is measured for Codex app-server turns and, since 2026-10-12, for
  OpenCode HTTP chat turns (cache reads count as cached input, reasoning as
  output). Claude broker CLI chat now has source support for per-turn measured usage; other broker runtimes and PTY boundaries report none. The only token budget is
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

### Claude broker ledger receipt (2026-11-03, CTX-001)

The one-shot `agent-chat` launcher requests Claude's native JSON result, keeps
its answer as plain stdout, and emits `SPACE_CLI_TURN_USAGE_V1` on stderr with
only usage counters and model names. The worker records `claude-cli:result`
provenance. Anthropic's uncached input, cache reads and cache writes together
form ledger input; only cache reads form cached input. Native output includes
reasoning without a separate reported reasoning split. Missing/invalid counters,
zero totals, overflow, duplicate receipts and truncated stderr stay `UNKNOWN`.
Only one reported model yields a model name; otherwise the model stays null,
without falling back to the requested model. `total_cost_usd` is not used as a
bill or measured cost; the existing price-catalog estimate or `UNKNOWN` remains.

This adds no Token Usage events: Claude transcripts and Gateway logs already
account for those calls. Offline wrapper and worker tests cover the receipt and
ledger boundary, including old text-only wrappers. The Claude launcher is installed
through stable promotion `q-20261103-104559-7c81`; new one-shot runs use it without
a pane-host restart. Real receipts from the installed wrappers parse as MEASURED (see
"Live broker receipts on stable" below); a ledger row from the whole path is still unread, and dev disables broker
turns. OpenCode source support is described below; other broker runtimes remain
unmeasured at this boundary. No token or cost cap was introduced.

### OpenCode broker receipt and Codex/Gemini routing (2026-11-03)

Codex is not a broker `agent-chat` runtime: it uses the existing measured
app-server route. The OpenCode broker and OpenCode HTTP routes both exist.
OpenCode v2.2.5 native source (`packages/cli/src/run/noninteractive.ts`,
`run.ts`, `ui.ts`, and `packages/schema/src/token-usage.ts`) confirms that
non-TTY stdout with thinking off contains only each trimmed text part followed
by a newline; tool presentation writes stderr. Its JSON adapter preserves that
stdout and emits only summed native counters, never session IDs, tool bodies,
reasoning text, answers or native cost. Each uniquely identified started step
must finish once in the same session, with a terminal final reason. Malformed,
incomplete, duplicate or invalid usage stays `UNKNOWN`. Input, cache reads and
writes are disjoint; output and reasoning are disjoint. The ledger includes the
cache in input and reasoning in output, with `opencode-cli:step_finish`
provenance. Native steps name no model, so model remains null and cost `UNKNOWN`.
A nonzero native exit suppresses measurement while preserving the worker's
existing fallback that accepts nonempty answer text. No aggregate events are
added; the Token Usage page already accounts for Gateway traffic.

Claude's launcher was installed by stable promotion `q-20261103-104559-7c81`,
OpenCode's by `q-20261103-113040-0ed3`; their real receipts are in "Live broker
receipts on stable" below. Dev's `NoNewPrivileges` prevents broker execution;
no proof bypass is attempted. Wrapper fixtures execute the real shell adapter
and drain its process-substitution streams; worker tests also retain the Codex
app-server delta regression. These are offline checks, not live provider proof.

### Live broker receipts on stable (2026-11-03, CTX-001)

No real CLI chat turn (Chat pane or Dot on `cli:claude`) ran since the promote of 10:51 UTC: the journal (kept from
2 Nov 18:12) shows 290 broker `agent-chat` runs up to 17:25 UTC, every one `cli:claude` from the chess benchmark
workspace (82 since the promote); chess moves keep neither a ledger row nor stderr. So there was no ledger row to read.
One minimal real turn per runtime then ran through stable's installed wrapper the way the broker's last hop runs it
(`--run-inner agent-chat` as `spaceapp-user`, clean environment, prompt on stdin), and its stderr went through stable's
built worker parser (`541946e42d`; the worker started 16:10 UTC, after the 16:07 build):

- Claude Code: one receipt, MEASURED `claude-cli:result`, input 1,690 (2 uncached + 1,688 cache write), cached 0,
  output 4, total 1,694, model `claude-opus-5-5`.
- OpenCode: one receipt, MEASURED `opencode-cli:step_finish`, input 19,570, output 140 (reasoning 140), total 19,710,
  model null, on `openrouter/openrouter/free`. The wrapper's default model `opencode/big-pickle` refused ("Free usage
  limit reached") and `space-gateway-claude/claude-haiku-5-5` was refused by Space Gateway (the Claude API key was over
  today's share of its monthly budget); a Chat pane passes its selected model, so the default is not what it runs.

The broker runs the wrapper with inherited stdio (`scripts/cli-vpn-broker.mjs`), so that stderr reaches the worker as
is; its only own line is the VPN wait notice. Evidence (receipts, parsed results, exit codes; answers deleted):
`~/agent-workspace/reports/20261103-ctx001-live-receipt`. Not yet read: a ledger row from the whole path (Chat pane,
worker, broker), since no route an agent may call returned a run's ledger. Space Control's inspection of a Chat pane now
gives its task the ledger's `usage` (counters, source, model, or UNKNOWN with its reason; never text; ticket
`q-20261103-173705-a69c`). After the next promote: an Agent Proof room, a Chat pane on `cli:claude` (and one on
`cli:opencode` with a model that serves), one prompt each through `space-admin-action control`, then `space_inspect`
section `MODELS` reads `tasks[0].usage`.

Gemini is also an actual shared broker runtime here, using Antigravity `agy` 1.4.12. Its JSON result was read from the binary itself
(2026-11-03: `--output-format json` offline, throwaway HOME, no account, no network, which answers the sign-in failure in the same shape):
`{conversation_id, status, response, error, duration_seconds, num_turns, usage: {input_tokens, output_tokens, thinking_tokens,
cache_read_tokens, total_tokens}, finished_reason}`, with no model. `gemini_agent_chat` in `deploy/gemini-vscode-parity` now runs JSON,
keeps the answer as plain text on stdout and writes one counters-only receipt (`runtime: cli:gemini`); a result with an error or status
ERROR is a failure even on exit 0. The worker's `geminiCliTurnUsage` (source `gemini-cli:result`, model null) records it MEASURED only
when `total_tokens` fixes how the cache reads are counted (input + output + thinking, or input + cache_read + output + thinking), else
`UNKNOWN`. Guards: `scripts/tests/gemini-agent-chat-usage.test.mjs`, the Gemini cases of `apps/worker/tests/cli-chat-output-budget.test.ts`.
The wrapper reaches `/opt/spaceapp/bin` only with a stable deploy (dev runs no broker turns), and the live account turn that proves which
reading agy uses waits for that guarded wrapper activation.

Qwen Code 0.26.6 (2026-11-04) gets the same receipt. Its JSON result was read from the binary itself, offline (no network namespace,
throwaway HOME, no account): against a local fake OpenAI-compatible endpoint, and with that endpoint down. `--output-format json` prints
one array of messages, the result last: `{type: result, is_error, result, usage, stats: {models: {<model>: {tokens: {prompt,
candidates, total, cached, thoughts}}}}}` (an error result has `error.message` and no stats). Its counters cover the whole turn,
background calls included (the probe's one prompt made two calls: the turn and Qwen's managed memory extraction). Prompt includes the
cache reads (Qwen's cache efficiency is cached / prompt). For an OpenAI-compatible provider, candidates are the completion tokens
(reasoning included) and total = prompt + candidates, and Qwen estimates thoughts from text when the provider reports none. Gemini's own
counters leave thoughts out: total = prompt + candidates + thoughts. `qwen_agent_chat` in `deploy/qwen-vscode-parity` now runs JSON,
prints the same answer text, keeps the quota and error words read from the answer or error text, and writes one counters-only receipt
(`runtime: cli:qwen`, each model's five counters, no names). The worker's `qwenCliTurnUsage` (source `qwen-cli:result`, model null) sums
the models and records MEASURED only when the total fixes one reading: reasoning 0 for prompt + candidates (an estimate is never
counted), thoughts for prompt + candidates + thoughts; anything else is `UNKNOWN`. Guards: `scripts/tests/qwen-agent-chat-usage.test.mjs`,
the Qwen cases of `apps/worker/tests/cli-chat-output-budget.test.ts`. Live like Gemini's: with a stable deploy and the guarded wrapper
activation.

DeepSeek (Reasonix 2.57.0, 2026-11-04) gets the receipt without changing its answer: `run --metrics <file>` writes Reasonix's own
JSON summary of the run, read from the binary itself offline (no network namespace, throwaway HOME and config, a local fake Anthropic
endpoint): `prompt_tokens` (the cache hits inside: hit + miss = prompt), `completion_tokens` (DeepSeek's thinking inside),
`cache_hit_tokens`, `cache_miss_tokens`, steps and a rate-card cost estimate. `run_agent_chat` in `deploy/deepseek-vscode-parity`
keeps its text output and filters, adds `--metrics` on a private temp file, and on exit 0 writes one counters-only receipt
(`runtime: cli:deepseek`, the four counters; never the cost, text or names), then removes the file. The worker's `deepSeekCliTurnUsage`
(source `deepseek-cli:metrics`, model null) records it MEASURED only when hits + misses are the prompt; reasoning is not broken out (0).
A Reasonix exit that is not zero keeps its answer (as before) and its usage `UNKNOWN`. Guards: `scripts/tests/deepseek-agent-chat-usage.test.mjs`,
the DeepSeek cases of `apps/worker/tests/cli-chat-output-budget.test.ts`. Live like Gemini's and Qwen's.

Kimi Code 2.4.1 (2026-11-04) prints no usage in either output format (`stream-json` carries only the version, the answer and a
resume hint), but every model call of a run becomes a durable `usage.record` event in the session's own log
(`<KIMI_CODE_HOME>/sessions/<workdir>/<session>/agents/<agent>/wire.jsonl`): `{inputOther, output, inputCacheRead, inputCacheCreation}`,
scope `turn` for the turn's calls and `session` for any other; each turn step's `step.end` event carries the same usage. A
chat-completions provider maps prompt minus cached to `inputOther`, cached to `inputCacheRead` and the completion tokens (reasoning
inside) to `output`. Read from the binary itself offline (no network namespace, throwaway HOME and `KIMI_CODE_HOME`, a fake endpoint;
one step, then a two-step turn with a real Glob call). `kimi_agent_chat` in `deploy/kimi-vscode-parity` keeps the text format and
answer; on success it takes the session from Kimi's own stderr line (`kimi -r session_<uuid>`, the exact form only), sums the
session's `usage.record` events (all, and the turn's) and its `step.end` usages with jq, and writes one receipt of those sums
(`runtime: cli:kimi`; sums only, so a long run stays inside the worker's 16 KB stderr window). A receipt never fails an answer. The
worker's `kimiCliTurnUsage` (source `kimi-cli:usage.record`, model null) records it MEASURED only when the turn's records equal its
steps (the log is whole) and the run's records cover the turn's; reasoning is not broken out (0). Guards:
`scripts/tests/kimi-agent-chat-usage.test.mjs`, the Kimi cases of `apps/worker/tests/cli-chat-output-budget.test.ts`. Live like the others.

GitHub Copilot CLI 1.0.105 (2026-11-04) prints only the answer with `-s`, but every model call of a session becomes a
`session.usage_record` event in its own log (`<COPILOT_HOME>/session-state/<session>/events.jsonl`): `inputTokens` (cache reads and
writes inside: 18,391 = 3 + 8,885 + 9,503 on a real call), `outputTokens` (reasoning inside), `cacheReadTokens`, `cacheWriteTokens`,
`reasoningTokens`, as the provider reports them; the session's `session.shutdown` totals them per model with the number of requests.
Read from the binary itself offline (no network namespace, throwaway `COPILOT_HOME`, BYOK on a local fake Responses endpoint; one
call, then a two-call turn with a real `view` tool call): the endpoint saw exactly the calls the log records, with the endpoint's
counters. `run_agent_chat` in `deploy/copilot-vscode-parity` keeps its text answer and arguments, adds `--session-id` with a new
UUID (Copilot's own way to name a new session), and on exit 0 writes one receipt of the records' sums and count and the shutdown's
(`runtime: cli:copilot`; counters only, no model, text or id). A receipt never fails an answer. The worker's `copilotCliTurnUsage`
(source `copilot-cli:usage_record`, model null) records it MEASURED only when there is exactly one shutdown and the records equal it
on every counter and on the number of calls, the cache counters fit in the input and the reasoning in the output; else `UNKNOWN`.
On public-host's real sessions (4/11) the rule holds for 134 of the 135 that have records and a shutdown; the 135th is a resumed session
with two shutdowns, which the rule refuses (agent-chat always starts a new one). Guards: `scripts/tests/copilot-agent-chat-usage.test.mjs`,
the Copilot cases of `apps/worker/tests/cli-chat-output-budget.test.ts`. Live like the others.

Hermes Agent 0.22.6 (2026-11-04) prints only the answer with `-z`, and its own `--usage-file <path>` writes a JSON usage report after
the run: the main loop (`input_tokens` is the prompt with the cache inside, `total_tokens` Hermes's own input + output, `api_calls`)
and an `auxiliary` block summing every auxiliary call by task, such as the title it generates after each reply (here `input_tokens`
leaves the cache out). Read from the binary itself offline (own network and PID namespaces with no route out, throwaway `HERMES_HOME`, Hermes's own
dependency environment with `HERMES_DISABLE_LAZY_INSTALLS=1`, a fake chat-completions endpoint): the endpoint saw the main calls
plus one title call, and the report holds both. A subagent's calls (`delegate_task`) are in no part of the report (one probe: four
calls, three reported), but its session is stored with the turn's session as parent; the one-shot turn runs in the gateway with
`skip_background_review`, so no review fork follows it. `hermes_agent_chat` in `deploy/hermes-vscode-parity` keeps its answer and
arguments, adds `--usage-file` on a private temp file, and on exit 0 writes one receipt (`runtime: cli:hermes`): the report's main
and auxiliary counters, the session's own `sessions` row in `state.db` (read-only, the main loop, input without the cache) and its
number of child sessions; then removes the file. A receipt never fails an answer. The worker's `hermesCliTurnUsage` (source
`hermes-cli:usage-file`, model null) records it MEASURED only when no subagent ran, the row equals the main loop on every counter and
the call count, the main total is its input + output, and the cache fits the input and the reasoning the output; else `UNKNOWN`.
Input adds the auxiliary calls' cache back. Guards: `scripts/tests/hermes-agent-chat-usage.test.mjs`, the Hermes cases of
`apps/worker/tests/cli-chat-output-budget.test.ts`. Live like the others.

Checked the same day and left `UNKNOWN`: Grok 1.0.70's JSON result has usage, but Grok computes its own total (input + cache read +
cache write + output, the provider's total ignored), so it cannot say whether its reasoning count is inside the output, and a second
model call after the reply is not counted at all; Cursor's JSON result has usage from its server's turn counters, but its `result` keeps
every text of the turn while the text format prints only the text after the last tool call, so switching would change answers (stream-json
and a live account check needed). Grok again on 2026-11-04 (1.0.70, same offline probe): its session `usage.json`
(`sessions/<cwd>/<session>/usage.json`, what `--grok-history` reads) has the same two gaps as its JSON result: `totalTokens` is
Grok's own input + output (1250 while the endpoint said 1280) and `modelCalls` is 1 while every run makes a second call after the
reply (it gets the user query and the agent's reply), counted nowhere; `--no-memory`, `GROK_SESSION_RECAP=0` and `GROK_TITLE_REFRESH=0`
(alone or together) leave that call in place. So any Grok receipt would undercount every turn: Grok broker turns stay `UNKNOWN`
until Grok counts every call it makes, and no code changed. Other previously documented CTX-001 gaps remain open.

Cursor again on 2026-11-04 (2026.10.22, read from its own bundle; no live turn: none could settle the gaps below). It keeps no local
usage: its chat store (`chats/<hash>/<id>/store.db`, blobs and meta) and `ai-tracking` hold no counters. Its only usage is the
server's `turnEnded` event, which print mode keeps as `usage` in the JSON and stream-json results: the last one wins (a run with
more than one action, such as a background shell's completion, reports only its last), input is `max(input - cache read - cache
write, 0)` (a clamp is indistinguishable from a real 0), and there is no total, reasoning split or second record to check it
against. The text format prints only the text after the last tool call and drops it on a fresh retry, while JSON keeps every text
and stream-json does not drop on a retry; switching would mean rebuilding Cursor's printer and could change answers. Cursor broker
turns stay `UNKNOWN`, no code changed. Autohand (context only; its wrapper belongs to the ADAPTER-006 resume work): its session
`metadata.json` has one cumulative `promptTokens`/`completionTokens` pair, with no cached or reasoning split, and most sessions
mark it `unavailable` (OpenRouter returned no usage); its broker turns stay `UNKNOWN`, not changed here.


### Kimi native usage on the Token Usage page (2026-11-04, CTX-001)

Kimi's existing broker receipt is per turn. The new `space-cli-token-usage --kimi-history` reader imports its native
subscription usage into Token Usage as well. It reads bookkeeping events from every agent's `wire.jsonl`, including
session-scope compaction calls. A `usage.record` must match the preceding `llm.request` on that agent, whose driver
is `kimi` and whose alias is `kimi-code/<reported model>`. Older OpenAI-compatible/custom routes are omitted because
an alias alone does not establish a direct billing route. Invalid, unpaired and out-of-window records are omitted.
Only ids, models, timestamps and counters leave the helper; it reads no credentials or settings.

The installed Kimi 2.4.1 source defines input as `inputOther + inputCacheRead + inputCacheCreation`. Output already
includes reasoning; no separate reasoning count or dollar price is inferred. The API upserts one event per session
and model, preserves cache read/write counters, and uses the existing five-minute ingestion cadence and 35-day
helper window. Account profiles share the session store, so these events identify the Kimi provider, not a specific
signed-in account. Repeated imports replace growing totals rather than adding them again.

Read-only native evidence: 2,555 usage records, of which 1,107 pair with the native Kimi driver. Replaying the reader
as of 2026-08-06 returns 31 sessions / 32 session-models: 116,507,804 input and 467,678 output tokens, with
113,015,740 cache-read tokens included in input. The last native-driver record is from 2026-08-05; today's import
window is empty. This historical replay proves the reader against real counters; it is not a new provider turn or
proof of live ingestion. Evidence, reproducible counter-only probe and installed binary source/hash:
`~/agent-workspace/reports/20261104-ctx001-kimi-native-usage/`.

The helper and its exact sudoers argument activate through the normal stable promote. Dev and tests keep the
privileged reader disabled. Guards: `scripts/tests/space-cli-token-usage.test.mjs`, the Kimi scheduled-ingest case in
`apps/api/tests/token-usage-sources.test.ts` (failed before the fix), and the helper admission case in
`scripts/tests/space-deploy-commit.test.mjs`. CTX-001 remains partial for its other gaps.
