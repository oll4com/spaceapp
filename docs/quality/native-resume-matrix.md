# Native resume matrix (ADAPTER-006)

## Read-only sweep, 2026-11-04 (Droid and Autohand)

Both installed CLIs support a resume reference. Neither qualifies for an
upstream-no-resume `accepted-tradeoff`. **ADAPTER-006 remains partial; 14 of 16
runtimes declare REFERENCE.** Autohand's source integration below was already
on dev when this sweep began; the registry's "no native resume" wording was stale.

The four probes ran from an isolated dev worktree with an empty scratch HOME,
closed stdin, a 60-second probe timeout and `unshare -Un --map-current-user`
(network unavailable). Each exited 0 with empty stderr. Only session directory
and file names were listed, masking native ids; no session/config contents,
interactive CLI, login or provider request was used.

Relevant output, verbatim:

```text
$ droid --version
0.244.0
$ droid --help
  -r, --resume [sessionId]                  Resume a session by id or session link (shows a session picker without one)
  --last                                    With --resume: skip the picker and resume the most recent session in the current folder

$ node <controlled-autohand>/node_modules/autohand-cli/dist/index.js --version
0.9.9 (ec2372d5)
$ node <controlled-autohand>/node_modules/autohand-cli/dist/index.js --help
  -r, --resume [reference]              Resume a saved session, or open the
                                        folder picker without one; with --cloud,
                                        resume an owned cloud session by ID or
                                        Web URL
  resume [options] [reference]          Resume a saved session by name, ID,
                                        path, or unique ID prefix; otherwise
                                        open the project picker
```

Autohand's controlled `current` resolves to `0.9.9-space.1`; the native version
above identifies its upstream build. Paths observed:

| Runtime | Session identity in native storage | Result |
| --- | --- | --- |
| Droid | `~/.factory/sessions/<cwd-slug>/<uuid>.jsonl`, beside `<uuid>.settings.json` and optional `.settings.json.bak` | Exact-ID source integration added; native capture and live proof pending |
| Autohand | `~/.codex/space-autohand/sessions/<uuid>-<timestamp>/metadata.json`, with `conversation.jsonl` where recorded | Existing full-ID source integration retained; authenticated live proof pending |

Droid's source integration passes a validated recorded id with `--resume <uuid>`
and resolves it from task history. A fixed native-owner reader inspects only
process identity, descriptor metadata and paths. It captures an id only when
the pane's actual Droid executable holds exactly one writable native session
JSONL file. It rejects foreign identities, read-only descriptors, ambiguity and
symlinked paths; it never selects a file by recency or reads its contents.
**This is an opportunistic binding, not an observed native storage contract:**
the installed Droid's descriptor lifetime is unproven. Without a descriptor it
returns no id. Fixture tests establish the reader's safeguards, not native capture.

The wrapper and anchored sudoers admit only the exact lowercase UUID form and
the fixed identity reader. An exact launch refuses a missing, ambiguous or
symlinked stored path. Without a valid recorded id the existing
`--resume --last` provider selection remains. Autohand retains its complete
`UUID-timestamp` identity and preflight described below. Both withhold
`declaresNativeReference` with `REFERENCE_PENDING_LIVE_PROOF`; declaring
`REFERENCE` requires real native capture and authenticated resume evidence.
Wrapper/sudoers activation follows the release path: dev launches through
stable's installed wrappers. No host restart, Warm change or promote was made.

Raw probe JSON and masked path inventories:
`~/agent-workspace/reports/20261104-adapter006-native-resume/`.
Scoped checks cover identity capture/refusal, nativeTaskRef persistence,
task-history resolution, wrapper preflight, launch admission and adapter contracts.

## Autohand source integration, 2026-11-03 (ADAPTER-006; live proof pending)

Installed Autohand `0.9.9-space.1` supports `--resume <reference>` and a bare
`--resume` picker. Space now has the source integration for its full native id
(`UUID-timestamp`), but keeps `declaresNativeReference=false` and
`REFERENCE_PENDING_LIVE_PROOF`. **14 of 16 runtimes still declare `REFERENCE`;**
this count is a declaration count, not a count of authenticated live proofs.

- `autohand-native-session.ts` binds native `active-agents/*.json` to a descendant
  of the pane host's root PID carrying both the pane and Space session ids. It
  validates the native session metadata, workspace and 15-second native heartbeat
  freshness, rejects ambiguity and heartbeats predating the process start, and
  reads no conversation or credentials. The fixed launcher operation runs as the
  native owner; native directory/file permissions remain unchanged.
- `NativeTaskTitles` and `TaskTitleService` persist that id as `native_task_ref`;
  the task-history resolver and spawn builder pass `--resume <full-id>`. The
  wrapper and anchored sudoers admit that form and the picker. No `--continue`,
  newest-session guess, title, prefix or caller-selected path is accepted.
- Native resolution tries a cwd-relative path before its saved-session directory.
  The wrapper therefore converts the id to the validated absolute native session
  directory and refuses a competing cwd/id path (startup resolves twice).
  `autohand-resume-reference.mjs` rejects missing/unreadable metadata,
  mismatched ids, corrupt JSON/JSONL, missing/empty recorded conversation, symlinks and
  files over its named 64 MiB JSON preflight safety budget. Refused state stays
  untouched and the session is not launched; no content is printed.
- **Upstream limitation:** native `resumeAgentSession` catches restoration and
  interactive-loop errors and can create a fresh session. Preflight prevents the
  known invalid-file/path-selection cases, but does not guarantee exact recovery
  after later native errors or concurrent file changes. No native client patch
  or authentication bypass was made.
- **Evidence:** an isolated fixture imported the installed native SessionManager
  and ActiveAgentHeartbeat, created synthetic A and newer B, reproduced a cwd-path
  collision across both native resolution stages, refused it, then loaded A's
  original history after removing the owned collision fixture, bound
  its actual process heartbeat, and rejected a corrupt conversation. Fixture
  HOME/state were removed. This is native-component evidence, **not a full CLI,
  authenticated Space resume, WebSocket/process/DB or provider-turn proof**.
  Evidence: `~/agent-workspace/reports/20261103-adapter006-autohand-resume/`.
- **Still required:** normal Autohand account sign-in, reviewed wrapper/sudoers
  activation through the release path, and authenticated native resume evidence.
  Dev's API cannot sudo/read the native owner's process namespace; source tests
  do not bypass that boundary. No host restart, live install, account/settings
  mutation or operator-session access was performed by this slice.

## Status update, 2026-11-03 (Qwen exact resume)

- **Qwen:** exact resume by session id, declared `REFERENCE`. 14 of 16 runtimes now declare it.
  - The proof was never only blocked by quota. Qwen 0.26.1 takes its writer lease (`runtime/tmp/session-writer-locks/`) only on the
    managed-session server path (`sessionWriterLeaseEnabled` is off in the TUI), so `deploy/qwen-task-metadata.mjs` answered
    `nativeId: null` for every pane and no reference was ever recorded.
  - The TUI keeps `projects/<cwd with / as ->/chats/<id>.runtime.json` (`pid`, `hostname`, `started_at`), rewritten on every session
    switch and left behind on exit. The bridge now falls back to it: the one session whose record names a pid of the pane's tree,
    this host, and a time after that process started (a recycled pid never adopts an old file). Only the tree's cwd folders are read.
  - RESUME already passed `--resume <uuid>` (`buildCliSpawnArgs`, sudoers) and the wrapper continues the latest when the store lacks
    the id; no `cli-terminal.ts` or Warm change.
  - Live check on public-host (Qwen 0.26.1, tmux, the real store): the bridge bound pane A to A's session (WORDA) and pane B to B's
    (WORDB); after both quit, `--resume <A>` in a third pane showed A's prompt and not B's while B was newer, wrote no new session, and
    the bridge bound that pane to A. The turns answered 402 (OpenRouter credits); the prompts are recorded before the model call.
    Evidence: `~/agent-workspace/active/20261103-adapter006-qwen/`.
  - Takes effect on stable with the promote that installs the bridge. Dev launches through stable's wrapper.
  - Tests: the runtime.json case of `scripts/tests/task-title-native.test.mjs`, the Qwen line of `cli-adapter-contract.test.ts`;
    `scripts/cli-launch-forms.json`.

## Status update, 2026-11-03 (Hermes and Kimi exact resume)

- **Hermes:** exact resume by session id, declared `REFERENCE` (12 of 16 runtimes then).
  - Hermes 0.22.5's TUI is a client of one shared gateway daemon (ppid 1). The active-session registry never holds the pane's process,
    so `deploy/hermes-task-metadata.py` answered `nativeId: null` for every pane. That also stopped Hermes title sync.
  - Each session's policy keeps the TUI's client env, frozen in `state.db` (`state_meta` `gateway.local_policy.v1:<id>`,
    `policy.client_env_json`). The wrapper adds `SPACE_CLI_SESSION_ID` to `terminal.client_env_passthrough` once
    (`ensure_space_client_env`).
  - The API sends the bridge the pane's Space session (`spaceSessionId`, `task-title-native.ts`). The bridge binds the newest native
    session whose policy names it; a resumed session keeps the policy that made it, so the `--resume <id>` in the pane's process tree
    names it instead.
  - The task titles record the id as `nativeTaskRef`. RESUME passes `--resume <id>` (`local-<64 hex>` or the older
    `YYYYMMDD_HHMMSS_<hex6>`, one anchored sudoers line), task-history resume resolves it, and without one RESUME stays `--continue`.
    Hermes exits "Session not found" on an id its store lacks, so the wrapper's `hermes_resume_args` then continues the newest instead.
  - Live check on public-host (Hermes 0.22.5, the gateway's real store, tmux): panes A and B each bound to their own session through the bridge.
    `--resume <A>` in a third pane answered A's word while B was newer, and the bridge bound that pane to A.
    Evidence: `~/agent-workspace/active/20261103-adapter006-hermes/`.
  - Takes effect on stable with the promote that installs the wrapper, bridge and sudoers. Dev launches through stable's wrapper.
  - Tests: the Hermes cases of `scripts/tests/task_title_hermes_test.py`, the hermes case of `scripts/tests/cli-maintenance-wrappers.test.mjs`,
    and the Hermes lines of `cli-resume-launch-admission.test.ts`, `cli-adapter-contract.test.ts` and `cli-native-task-resume.test.ts`;
    `scripts/cli-launch-forms.json`.
- **Droid:** not done. Droid 0.244.0 has `--resume [sessionId]` and no flag that names a new session. Its sessions live in
  `~/.factory/sessions/<cwd-slug>/`. It asks for a Factory login on public-host, so no live session can be observed or bound.
- **Kimi:** exact resume by session id, declared `REFERENCE` (13 of 16 runtimes then).
  - Kimi Code 2.4.1 resumes with `--session <id>` and has no flag that names a new session; a session is created on its first message.
  - While a turn runs, Kimi leases the session in `<KIMI_CODE_HOME>/locks/sessions/<id>.lock` (JSON with the holder's pid and hostname;
    account profiles have their own `profiles/<name>/locks/sessions/` and share `sessions/`). A resumed session leases the same id.
  - A fixed launcher read (`kimi-vscode-parity --run-inner native-session`, `scripts/kimi-native-session-read.mjs`,
    `apps/api/src/kimi-native-session.ts`) answers the one lease held by a process under the pane's root process whose environment
    carries the pane's Space identity, on this host. Between turns there is no lease and the task titles keep the id they recorded.
  - RESUME passes `--session <id>` (`session_<lowercase uuid>` only, an anchored sudoers line); task-history resume resolves it; without a
    recorded id RESUME stays the `--session` picker. Kimi exits "Session not found" on an id it does not store, so the wrapper's
    `kimi_resume_args` opens the picker when no `sessions/*/<id>/state.json` exists.
  - Live check on public-host (Kimi 2.4.1, tmux): pane A's turn leased A (holder: A's pid); pane B then made a newer session; `--session <A>` in a
    third pane reopened A with A's prompt in its history and leased A under its own pid. The Kimi subscription answered 403 to every turn
    on this host; the lease is taken before the model call. Evidence: `~/agent-workspace/active/20261103-adapter006-kimi/`.
  - Only `apps/api/src/cli-terminal.ts`'s `buildCliSpawnArgs` changed for the launch, as for Hermes, Muse and OMP; no `apps/web` or Warm file.
  - Takes effect on stable with the promote that installs the wrapper, read script and sudoers. Dev launches through stable's wrapper.
  - Tests: `apps/api/tests/kimi-native-session.test.ts`, the kimi case of `scripts/tests/cli-maintenance-wrappers.test.mjs`, the Kimi lines of
    `cli-resume-launch-admission.test.ts`, `cli-adapter-contract.test.ts` and `cli-native-task-resume.test.ts`; `scripts/cli-launch-forms.json`.

## Status update, 2026-11-02 (Muse exact resume)

- **Muse:** exact resume by session id, declared `REFERENCE`.
  - Muse 1.4.14 `resume <uuid>` reopens a stored session and exits "retained session not found" on one it does not hold, so Space
    records the session the pane's live Muse runs, as for OMP and Qwen.
  - The live `muse-bin` holds its session folder's `.session.lock` open (`~/.local/share/muse/sessions/YYYY/MM/DD/<uuid>/`; a resumed
    session reopens the same folder). A fixed launcher read (`muse-vscode-parity --run-inner native-session`,
    `scripts/muse-native-session-read.mjs`, `apps/api/src/muse-native-session.ts`) finds it from the `/proc` fd links of the process
    carrying the pane's Space identity, reading no file.
  - The task titles record the id as the revision's `nativeTaskRef`. RESUME passes `resume <id>` (lowercase UUID only, an anchored
    sudoers line), task-history resume resolves it, and without a recorded id RESUME stays `resume --last`. A recorded session Muse no
    longer holds also reopens the latest: the wrapper's `muse_resume_args` turns `resume <id>` into `resume --last` when no
    `sessions/*/*/*/<id>/session.jsonl` exists.
  - Live check on public-host (Muse 1.4.14, a throwaway HOME, `--provider echo` in tmux): session A, then session B, the newest.
    `resume <A>` showed A's message, the reader bound the running process to A, and another pane read nothing.
  - Takes effect on stable with the promote that installs the wrapper, sudoers and launcher read.
  - Tests: `apps/api/tests/muse-native-session.test.ts` and the muse case of `scripts/tests/cli-maintenance-wrappers.test.mjs` (both fail
    before the change), the Muse lines of `cli-resume-launch-admission.test.ts`, `cli-adapter-contract.test.ts`,
    `cli-native-task-resume.test.ts`, `qwen-native-resume-ref.test.ts`; `scripts/cli-launch-forms.json`.
- **Count:** 11 of 16 runtimes declare `REFERENCE`: Codex, Claude, OpenCode, DeepSeek, Gemini, Copilot, Qoder, Grok, Cursor, OMP and Muse.

## Status update, 2026-11-02 (OMP exact resume)

- **OMP (Oh My Pi):** exact resume by session id, declared `REFERENCE`.
  - omp 18.14.2 `--resume <id>` reopens a stored session and refuses an id it does not store, so Space cannot name a session
    before it starts (unlike Cursor and Copilot). It records the session the pane's live omp runs instead, as for Qwen.
  - The session's id comes from the terminal breadcrumb (`~/.omp/agent/terminal-sessions/pts-N`, line 2 the session file), whose
    header `{"type":"session","id":…}` names it. It is read by the existing launcher read (`omp-vscode-parity --run-inner native-model`,
    `scripts/omp-native-model-read.mjs`, now also printing `sessionId`).
  - The task titles record the id as the revision's `nativeTaskRef` (`task-title-native.ts`, `task-title-service.ts`). RESUME passes
    `--resume <id>` (`buildCliSpawnArgs`, lowercase UUID only), task-history resume resolves it (`cli-native-task-resume.ts`), and the
    sudoers line admits only that form. Without a recorded id RESUME stays `--continue`.
  - A recorded session omp no longer stores (omp would fail "Session … not found") also continues: the wrapper's
    `omp_resume_args` turns `--resume <id>` into `--continue` when no `sessions/*/*_<id>.jsonl` exists (Qwen's wrapper does the same).
  - Live check on public-host (omp 18.14.2, a throwaway HOME, the TUI in tmux): session A (OLDER-PANE-TASK), then session B, the folder's
    newest. `omp --resume <A>` showed A's message, and the breadcrumb named A's file.
  - Dev launches CLIs through stable's wrappers, sudoers and launcher read. So the id is recorded and the exact form takes effect only
    with the promote that installs them.
  - Tests: the OMP lines of `apps/api/tests/cli-resume-launch-admission.test.ts` (fails before the change), `cli-adapter-contract.test.ts`,
    `cli-native-task-resume.test.ts`, `omp-native-model.test.ts`, `qwen-native-resume-ref.test.ts`; `scripts/cli-launch-forms.json`.
- **Count:** 10 of 16 runtimes declare `REFERENCE`: Codex, Claude, OpenCode, DeepSeek, Gemini, Copilot, Qoder, Grok, Cursor and OMP.

## Status update, 2026-11-02 (Cursor exact resume)

- **Cursor:** exact resume by chat id, declared `REFERENCE` (`REFERENCE_STEERED_BY_WRAPPER`).
  - Cursor 2026.10.22 `--resume <uuid>` starts a new chat on an id it does not store yet and reopens a stored one, so Space names
    the chat before the first start, as for Copilot.
  - Each start carries the pane's own chat id in `SPACE_CURSOR_SESSION_ID` (`buildCliEnvironment`; derived from the Space session
    with `spaceNamedSessionId("cursor", …)`, or the recorded `nativeTaskRef`; kept by `zz-space-cli-env.sudoers`).
  - The wrapper (`cursor_space_session_args` in `deploy/cursor-vscode-parity`) launches `cursor-agent --resume <id>` on a fresh start,
    and on RESUME once `chats/*/<id>` exists; otherwise the `--continue` it was given stays Cursor's latest chat. Space's argv and the
    Cursor sudoers are unchanged.
  - Live check through the wrapper's inner mode on public-host (Cursor 2026.10.22, model Auto):
    - A fresh TUI with id A (`329190dc-…`) ran `--resume A`, created `chats/<hash>/A` and remembered ECHO.
    - A fresh chat B then remembered FOXTROT and became the newest.
    - `--run-inner --continue` with A's id ran `--resume A`, redrew A's turn and answered ECHO.
    - Evidence: `~/agent-workspace/active/20261102-adapter006-cursor/`.
  - Dev launches CLIs through stable's wrappers, so the exact form takes effect with the promote that installs the wrapper and sudoers.
  - Tests: the Cursor lines of `apps/api/tests/cli-adapter-contract.test.ts` and `cli-native-task-resume.test.ts`, the Cursor case in
    `scripts/tests/cli-maintenance-wrappers.test.mjs`; `scripts/cli-launch-forms.json`.
- **Set aside:**
  - **Hermes 0.22.5** (superseded 2026-11-03, above): `--resume <id>` reopens a session (checked live). But its TUI runs the agent in a shared gateway daemon
    outside the pane's process tree, holds no active-session lease between turns, writes no terminal breadcrumb, and has no flag that
    names a new session. So Space cannot bind a session to a pane.
  - **Droid and Kimi:** neither is signed in on public-host (Droid asks for a Factory login, Kimi's credential smoke fails), so no live check.
- **Count:** 9 of 16 runtimes declare `REFERENCE`: Codex, Claude, OpenCode, DeepSeek, Gemini, Copilot, Qoder, Grok and Cursor.

## Status update, 2026-11-02 (Grok exact resume)

- **Grok:** exact resume by session id, declared `REFERENCE` (`REFERENCE_STEERED_BY_WRAPPER`).
  - Each start carries the pane's own Grok session id in `SPACE_GROK_SESSION_ID` (`buildCliEnvironment`; derived from the
    Space session with `spaceNamedSessionId("grok", …)`, or the recorded `nativeTaskRef`; kept by `zz-space-cli-env.sudoers`).
  - The wrapper (`grok_space_session_args` in `deploy/grok-vscode-parity`) launches `grok --session-id <id>` on a fresh start and
    `grok --resume <id>` once `$GROK_HOME/sessions/*/<id>` exists; a `--resume` whose session is not stored stays Grok's most
    recent one. Grok 1.0.70's `--session-id` only names a new session: a stored id is refused "already in use".
  - Live check through the wrapper's inner mode on public-host (grok 1.0.70): sessions A (ALPHA), B (BRAVO) and C (CHARLIE, the newest);
    a fresh start with C's id ran `--session-id C`, and `--resume` with A's id ran `--resume A` and answered ALPHA.
  - Dev launches CLIs through stable's wrappers, so the exact form takes effect with the promote that installs the wrapper and sudoers.
  - Tests: the Grok lines of `apps/api/tests/cli-adapter-contract.test.ts` and `cli-native-task-resume.test.ts`, the Grok case in
    `scripts/tests/cli-maintenance-wrappers.test.mjs`; `scripts/cli-launch-forms.json`.
- **Count:** 8 of 16 runtimes declare `REFERENCE`: Codex, Claude, OpenCode, DeepSeek, Gemini, Copilot, Qoder and Grok.

## Status update, 2026-11-02 (Qoder exact resume)

- **Qoder:** exact resume by session id, declared `REFERENCE`.
  - The launcher already passed the pane's Space-named session: `--session-id <uuid>` on a fresh start, `-r <uuid>` on
    RESUME (`qoder-native-session.ts`; sudoers anchored to a lowercase UUID since `6d3105f213`). Only the live proof was missing.
  - Live check through the wrapper's inner mode on public-host (qodercli 1.1.81; Qoder's own credits are exhausted, so the turns ran on
    its `space-gateway-claude` provider): session A remembered ALPHA, a newer session B remembered BRAVO, and `-r A` answered
    ALPHA. A's transcript gained the answer, B's did not, and no third session was created.
    Evidence: `~/agent-workspace/active/20261102-adapter006-qoder/`.
  - The wrapper's fallback stays: an id whose session holds no answer yet starts a fresh session.
  - Test: the Qoder line of `apps/api/tests/cli-adapter-contract.test.ts`; `scripts/cli-launch-forms.json`.
- **Qwen:** probed first; its Coding Plan reports `READY_QUOTA_EXHAUSTED`, so it keeps `REFERENCE_PENDING_LIVE_PROOF`.
- **Count:** 7 of 16 runtimes declare `REFERENCE`: Codex, Claude, OpenCode, DeepSeek, Gemini, Copilot and Qoder.

## Status update, 2026-11-01 (Copilot exact resume)

- **Copilot:** exact resume by session id, declared `REFERENCE`.
  - Copilot CLI 1.0.105 `--session-id <uuid>` resumes a session by id or sets the UUID of a new one, so pre-assignment no longer blocks it.
  - Every start carries the pane's own id in `SPACE_COPILOT_SESSION_ID` (derived from the Space session id, or the recorded one; kept by
    `zz-space-cli-env.sudoers`). The wrapper launches `copilot --session-id <id>` on a fresh start, and on RESUME when the store holds
    `session-state/<id>`, else the `--continue` it was given.
  - Live check through the wrapper's inner mode on public-host: session A resumed by id while a newer session B was the latest.
  - Test: the ADAPTER-006 case in `scripts/tests/cli-maintenance-wrappers.test.mjs`.
- **Count:** 6 of 16 runtimes declare `REFERENCE`: Codex, Claude, OpenCode, DeepSeek, Gemini and Copilot.

## Status update, 2026-11-02 (Gemini live check on dev, EXT-G-6)

- **Run:** Space Control as the operator in an Agent Proof room on dev, server CALM.
  - Pane: `cli:gemini` on the `space-gateway` profile, Antigravity CLI 1.4.12.
  - Evidence: `~/agent-workspace/reports/20261102-ext-g-6-gemini/summary.json`.
- **Proven:**
  - Start.
  - A test prompt answered; Space recorded conversation `05644479-…` as the pane's `nativeTaskRef`.
  - Interrupt during a turn.
  - `/quit`: agy printed `agy --conversation=<the same id>`.
- **Found and fixed:** Space Control's `start` after the exit opens a new session, as `startCli` should.
  - It reported that start as UNKNOWN "The original native task has not been confirmed after resume."
  - Fixed: only reopen, restart and resume are held to the prior native task.
  - Guard: the EXT-G-6 case in `apps/api/tests/space-control.test.ts`.
- **Second run (after the stable promote of 2026-11-02, `9687e9fb58`):** evidence `summary-2.json` in the same folder.
  - **Exact resume by id: passed** through `space-admin-action control` `resume`, after two fixes on dev:
    - The resume came up on the direct account `main`, not the task's `space-gateway`. A Gemini conversation lives in its
      account's store, so a Gemini task now resumes on its own account (`resumeAccountSource` in `pane-cli-resume.ts`).
    - On the right account it still opened another conversation: a task resume carried no id, so agy fell back to
      `--continue`. The Gemini resolver now records the conversation as the task's reference (`persistAsNativeTaskRef`),
      so the launch's `SPACE_GEMINI_CONVERSATION_ID` names it. Dev cannot write the pane conversation file; stable's
      wrapper still gets it.
    - Then: agy printed conversation `e4f7d48d-…` on `/quit`, the resume (mode `NATIVE_RESUME`) showed the original
      prompt, and a follow-up asking for the test word, with no tool, answered it.
    - On dev Space Control still answers UNKNOWN after a Gemini resume: the dev API's private PID namespace and its
      read-only `/opt/spaceapp` leave the resumed session's `nativeTaskRef` empty. The answer itself proves the conversation.
  - **Browser reattach: passed on stable after the next promote.** `PROVE_CLI_INPUT` first failed "did not start on the selected Gemini account profile": it
    picked a direct account, while a new pane starts on `space-gateway` whenever the gateway is ready. The proof now selects
    the ready Space Gateway profile first (the earlier "try an unreported account" fallback was dropped: that account does
    not serve). It runs stable's script; after promote `q-20261102-003539-dace` it passed on stable: the terminal reattached to the same session
    after the page reload and the transcript kept the input and the answer (`cli-input-stable-1.json`).
  - **The account with no Gemini quota figures (`main`) does not serve a turn:** "Individual quota reached … Resets in
    54h52m49s". Space showed the pane IDLE with `usageLimited` false; Space now reads this Antigravity message as a usage limit (dev, `agents-dashboard.test.ts`).
  - **Account switch:** ADAPTER-010 records that a Gemini account switch deletes the pane's conversation file before the
    restart (a note with a failing-first test idea, no code).
- **Host loss:** stays unproven; it needs a pane-host restart.

## Status update, 2026-10-30 (Gemini exact resume)

- **Gemini:** exact resume by conversation id (`agy --conversation <id>`),
  declared `REFERENCE` (commit `b72c5d17b2`; on stable since the promote of
  2026-10-30, `d8d0176e6c`). On RESUME the API still passes `--continue` with the
  recorded id in `SPACE_GEMINI_CONVERSATION_ID`. The wrapper launches
  `agy --conversation <id>` when the pane's own conversation (that variable, or
  the pane or tty file) is in the active account's store after its copy.
  Otherwise it keeps the steered `--continue`. No sudoers change was needed.
  - Live check through the wrapper's inner mode on public-host, not a Space Agent Proof
    room: conversation A resumed by id while a newer conversation B was the
    workspace's latest.
  - Test: `scripts/tests/gemini-qwen-runtimes.test.mjs`.
- **Count:** 5 of 16 runtimes declare `REFERENCE`: Codex, Claude, OpenCode,
  DeepSeek and Gemini.
  - Ten reach only a provider selection. Two of them, Qwen and Qoder, pass a
    recorded reference pending a live proof.
  - Autohand has no native resume.
- **Hermes:**
  - Hermes 0.22.4 mints `local-<64 hex>` session ids.
  - It runs the agent in a shared gateway daemon outside the pane's process tree.
  - So `deploy/hermes-task-metadata.py` binds no session to a pane: it returned
    `nativeId: null` in a live probe.
  - Exact resume for Hermes needs a new way to bind a pane to its session.

## Status update, 2026-10-11 (contract suite and canary)

- **Qoder** now runs every Space session under a Space-named session id
  (`--session-id <uuid>` fresh, `-r <uuid>` on resume, `qoder-native-session.ts`),
  admitted by its sudoers. Like Qwen it declares `REFERENCE_PENDING_LIVE_PROOF`
  instead of `REFERENCE`.
- **OMP** declares `--continue` as its provider selection, not a bare `--resume`.
- **Autohand** prints its help after about 20 s offline; the 15 s probe below
  timed out. Its help lists `--path`, `--unrestricted`, `--prompt`,
  `--restricted` and `--login`.
- Every declared resume form, and the limitation each runtime declares, is now
  derived and checked by `apps/api/tests/cli-adapter-runtime-contract.test.ts`;
  versions and flags per exact version come from `scripts/cli-canary.mjs`. See
  `runtime-compatibility.md`.

## Status update, 2026-10-11 (later)

- **DeepSeek:** the CLI parity deploy `0d2ede0ca6` added `--run-inner --resume *` to its sudoers. Its wrapper accepts only two arguments and a recorded Reasonix ref. The admission test no longer records the gap.
- **Qwen:** implemented in this remediation.
  - The `task-metadata` id, bound to the pane's process, is written to the revision's `nativeTaskRef`.
  - RESUME launches `--resume <uuid>` through the wrapper filter and the anchored sudoers regex `^--run-inner --resume [0-9a-f]{8}-…$`.
  - The wrapper falls back to `--continue` when the session file is not in the workspace's store.
  - The declaration stays provider selection until a live resume proof exists, because the proof backend has no fixed resume proof for non-Codex CLIs.
- **Not changed, deliberately:**
  - **Gemini:** its steered `--continue` already targets the recorded conversation.
  - **Hermes:** the bridge may report a live id rather than the stored id.
  - **Grok:** pre-assignment changes every fresh launch (Copilot: see 2026-11-01).
  - **Kimi, Cursor, OMP and Qoder:** flag or id semantics are unverified.

  Each needs a live check before Space passes ids.

Research date: 2026-10-11, host public-host (`codex-dev`), source at `3dd913eb48`.

This matrix records, for the runtimes that ADAPTER-006 lists as "provider
selection only", whether the installed CLI can resume one specific session,
where it keeps session identities, whether Space can learn the identity of a
pane's session, and what blocks exact resume today. It does not certify live
resume behavior: no CLI session, login, prompt or provider request was started.

## Method and evidence

- **Help and version probes.** Each installed binary ran only `--help`,
  `<subcommand> --help` or `--version`. Each probe used a 15 s timeout, an empty
  scratch `HOME`, and a private network namespace (`unshare -Un
  --map-current-user`), so no update check or provider call could leave the
  host. The raw help text is under
  `/var/lib/spaceapp-user/agent-workspace/reports/adapter-006-native-resume/help/`.
- **Session storage.** Only directory and file names were listed for user
  `spaceapp-user`. Identifiers were masked as `<uuid>`, `<hex>` and `<n>`. No file
  contents were read.
- **Launch admission.** Space starts every runtime as user `space` through
  `/opt/spaceapp/bin/<runtime>-vscode-parity`. The wrapper's outer mode
  re-executes itself with `sudo -n -u spaceapp-user <wrapper> --run-inner <args>`.
  The VPN broker path also ends in this `sudo`. A resume argument therefore has
  to pass two gates: the wrapper's `require_allowed_args` filter and the
  `Cmnd_Alias` in `/etc/sudoers.d/space-<runtime>-vscode-parity`.
  - The sudoers gate was checked against the live policy with the read-only
    query `sudo -n -l -U space -u spaceapp-user <command line>`, which prints
    without executing anything. Results are in `sudo-list-space.txt` in the
    same reports directory.
  - The installed wrappers are byte-identical to `deploy/*-vscode-parity`.
  - The installed sudoers files have the same sizes as `deploy/*.sudoers`.
- **Labels.** "Unverified" marks every statement taken from help text or file
  names that was not observed in a running session.

## Cross-cutting findings

1. **The sudoers allow-lists block every resume-by-id form for the nine
   runtimes.** Every resume command line that carries a session id is refused
   by the live policy for Gemini, Qwen, Kimi, Grok, Cursor, Copilot, Hermes,
   OMP and Qoder, whichever flag the CLI uses for it. Only the bare provider
   forms are admitted (`--continue`, `--session`, `--resume`). Exact resume for
   any of them needs a root-owned sudoers change first. Until that change
   lands, a Space change that passes an id in `buildCliSpawnArgs` would make
   the resume launch fail at `sudo -n` ("a password is required"). Today's
   launch would continue the latest session instead.
2. **DeepSeek's exact resume is refused at launch.** `buildCliSpawnArgs` emits
   `--resume <ref>` for `cli:deepseek`, and the wrapper admits it. The live
   policy refuses `deepseek-vscode-parity --run-inner --resume <ref>`. DeepSeek
   was one of the four runtimes counted as implemented on that date. The live `sudo -l`
   result is verified. Whether a pane then exits is inferred and unverified.
   The repository fix is one sudoers line, for example
   `/opt/spaceapp/bin/deepseek-vscode-parity ^--run-inner --resume (session_[0-9a-f]{32}|/var/lib/spaceapp-user/\.reasonix/projects/[A-Za-z0-9._-]+/sessions/[A-Za-z0-9._-]+\.jsonl)$`,
   plus a matching validation in the wrapper. This is a root-owned follow-up.
3. **Qoder's provider-selection resume was refused at launch.** The descriptor
   declared `--resume`, but the Qoder sudoers admits only `--continue` and
   `-c`, so a host-loss restore of a Qoder pane could not start. The
   2026-10-11 slice switches the descriptor to `--continue`, which is
   admitted, accepted by `qodercli`, and has the same "latest session"
   semantics. The static test `apps/api/tests/cli-resume-launch-admission.test.ts`
   now checks every declared resume form against the repository wrapper
   filters and sudoers files. It records the DeepSeek gap as known and asserts
   that the nine resume-by-id forms are still refused.
4. **The previous inventory recorded OMP as not installed.** On this date
   `omp` 18.6.3 is present at `/var/lib/spaceapp-user/.npm-global/bin/omp`, which is
   on the wrapper's search path. Its `#!/usr/bin/env bun` shebang resolves
   through `/var/lib/spaceapp-user/.bun/bin`, which the wrapper puts on `PATH`.
5. **Session identities can be discovered deterministically, not only by
   guessing from cwd and time.** Claude's reference is bound through a
   per-process session record: the PID descends from the pane root, the
   process start time matches, and the environment carries the Space pane and
   session ids. Several runtimes keep a comparable record:
   - **Hermes:** active-session registry with PID and start time.
   - **Qwen:** session-writer locks with PID and start identity.
   - **Gemini:** open conversation database file descriptors.
   - **Copilot:** `inuse.<pid>.lock` inside each session directory, semantics
     unverified.
   - **Grok:** `active_sessions.json`, schema unverified.

   Four CLIs also accept a caller-chosen id for a new session, which removes
   discovery altogether: Qwen (`--session-id`), Grok (`-s/--session-id`, new
   sessions only), Copilot (`--session-id`, new or existing) and Qoder
   (`--session-id`, semantics unverified).

## Per-runtime matrix

### Gemini (Antigravity CLI `agy`)

| Field | Finding |
| --- | --- |
| Installed version | `agy --version` reports `1.3.3`. The managed link `cli-versions/gemini/current` points at directory `1.3.1`. |
| Resume by id | `--conversation <id>`: "Resume a previous conversation by ID". `--continue`/`-c` continues the most recent conversation. |
| Session storage | `~/.codex/space-gemini/home/.gemini/antigravity-cli/{conversations/<uuid>.db, conversation_summaries.db, presence/, brain/<uuid>/, cache/last_conversations.json}`. The same tree exists per account under `profiles/<id>/home/...` and is merged into `shared-history/`. |
| Id discoverability | Deterministic for a live pane: `gemini-native-session.ts` reads `conversations/<uuid>.db` or `presence/<uuid>.lock` from the pane process tree's file descriptors. A fallback picks the latest conversation for the workspace from `conversation_summaries.db`; this fallback is heuristic. |
| What Space does today | It records the id as the session's `codexThreadId`, in the revision's `nativeTaskRef`, and in `/opt/spaceapp/var/gemini-pane-conversations/pane-<id>.json`. It launches `--continue` and passes the id in `SPACE_GEMINI_CONVERSATION_ID`, which the sudoers `env_keep` admits. The wrapper copies the conversation database into the active profile. Since 2026-10-30 it then launches `agy --conversation <id>`: exact resume by conversation id, declared `REFERENCE`. Without a recorded conversation in the store, it pre-seeds `cache/last_conversations.json` and keeps `--continue`. Task-history resume reports `NATIVE_RESUME`. |
| Admission | `--run-inner --continue` is admitted. `--run-inner --conversation <id>` is refused by sudoers and by the wrapper filter. |
| Recommendation | Done 2026-10-30 (`b72c5d17b2`, live check of the wrapper path; see the status update above). Original recommendation: keep the API arguments at `--continue` and change only the wrapper's inner exec: when `SPACE_GEMINI_CONVERSATION_ID` is a valid UUID and `conversations/<id>.db` exists in the active state root, exec `agy --dangerously-skip-permissions --conversation <id>`; otherwise keep `--continue`. This needs no sudoers change because the id already travels in a kept environment variable. Declare `REFERENCE` only after a live proof in an Agent Proof room shows the same conversation id before and after a host-loss restore. |

### Qwen Code

| Field | Finding |
| --- | --- |
| Installed version | `0.23.2`; managed directory `0.23.2-space.1`. |
| Resume by id | `-r, --resume <id>`: "Resume a specific session by its ID". `--session-id <id>`: "Specify a session ID for this run". `-c, --continue`: most recent session for the project. |
| Session storage | `~/.codex/space-qwen/runtime/projects/<cwd-slug>/chats/<uuid>.jsonl`. Live writer locks are in `runtime/tmp/session-writer-locks/*.lock`. |
| Id discoverability | Deterministic. `deploy/qwen-task-metadata.mjs` matches a writer lock's PID and process start identity against the pane process tree and requires exactly one active interactive session with a UUID id. A caller-chosen `--session-id` at launch would remove discovery entirely: unverified that a new session keeps exactly that id. |
| What Space does today | `--continue` on RESUME. The task-title bridge (`task-title-native.ts`, wrapper `task-metadata`) learns the native id, but only for title sync; it is not written to `nativeTaskRef`. |
| Admission | Sudoers admits `--run-inner --continue` only. The wrapper admits one-argument `--continue`. `--resume <id>` and `--session-id <id>` are refused by both. |
| Recommendation | Root adds `^--run-inner --resume [0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, and the wrapper admits the same validated form. Then persist the id that `task-metadata` resolves into the revision's `nativeTaskRef`, as Claude does, and add a `cli:qwen` branch in `buildCliSpawnArgs` gated by a strict UUID pattern. Later, pre-assign the id with `--session-id` on fresh launches. |

### Kimi Code

| Field | Finding |
| --- | --- |
| Installed version | `2.1.1`. |
| Resume by id | `-S, --session [id]`: "With ID: resume that session. Without ID: interactively pick." `-c, --continue` continues the previous session for the working directory. |
| Session storage | `~/.codex/space-kimi/sessions/wd_<slug>_<hash>/session_<uuid>/{state.json, logs/, agents/}`, plus `session_index.jsonl` and `sessions/.index-cache/scan.json`. Unverified whether `--session` expects `session_<uuid>` or the bare `<uuid>`. |
| Id discoverability | Heuristic only. `kimi session list --cwd <path> --json` lists sessions most recent first. No PID-keyed live registry was found by file name. |
| What Space does today | It launches bare `--session`, which opens Kimi's interactive picker. No native id is recorded. |
| Admission | Sudoers admits `--run-inner --session` only. The wrapper admits one-argument `--session`. `--session <id>` is refused. |
| Recommendation | Not determinable without a live session. First confirm the id form `--session` accepts and find a race-free way to bind a pane to its session, for example a Kimi live-session record keyed by PID. Until then, keep provider selection. If a picker is undesirable for host-loss restore, `--continue` is the non-interactive "latest for cwd" form, but sudoers does not admit it today. |

### Grok Build

| Field | Finding |
| --- | --- |
| Installed version | `grok 1.0.50 (c58f321264ba)`. |
| Resume by id | `-r, --resume [<SESSION_ID_OR_TITLE>]`: UUID-shaped values always mean ids, and an omitted value resumes the most recent. `-s, --session-id <UUID>` sets the id of a new conversation; it does not resume. |
| Session storage | `~/.codex/space-grok/sessions/<url-encoded cwd>/<uuid>/{chat_history.jsonl, events.jsonl, summary.json, ...}`, with `active_sessions.json` and `sessions/session_search.sqlite` at the root. |
| Id discoverability | Deterministic in principle: Space can pre-assign a UUID with `--session-id` on a fresh launch and record it before the process starts. `active_sessions.json` may also map live processes to sessions (schema unverified). |
| What Space does today | It launches bare `--resume`, which resumes the most recent session for the cwd. No id is recorded. |
| Admission | Sudoers admits `--run-inner --resume` only. The wrapper admits one-argument `--resume`. `--resume <uuid>` and `--session-id <uuid>` are refused. |
| Recommendation | Pre-assignment is the cleanest exact design: generate a UUID per fresh pane task, launch `--session-id <uuid>`, persist it as `nativeTaskRef`, and resume with `--resume <uuid>`. This needs sudoers and wrapper entries for both validated forms. The launch-time recording also touches the fresh-launch path, so it needs its own review. |

### Cursor Agent

| Field | Finding |
| --- | --- |
| Installed version | `2026.10.01-e373342`. |
| Resume by id | `--resume [chatId]`: "Select a session to resume". `--continue` continues the previous session. The `create-chat` subcommand creates an empty chat and returns its id; unverified whether it needs the network. |
| Session storage | `~/.codex/space-cursor/chats/<workspace-hash>/<uuid>/{meta.json, store.db}` and `~/.codex/space-cursor/.cursor/projects/<cwd-slug>/agent-transcripts/<uuid>/<uuid>.jsonl`. Each profile has its own tree under `profiles/<id>/`. |
| Id discoverability | Unverified. `create-chat` followed by `--resume <chatId>` would pre-assign the id. No PID-keyed live registry was found by file name. |
| What Space does today | `--continue`. No id is recorded. |
| Admission | Sudoers admits `--run-inner --continue` only. The wrapper admits one-argument `--continue`. `--resume <id>` is refused. |
| Recommendation | Verify offline that `create-chat` works and that `--resume <chatId>` opens that chat. Then follow the Grok pre-assignment design, with sudoers and wrapper entries for `--resume <uuid>`. |

### GitHub Copilot CLI

| Field | Finding |
| --- | --- |
| Installed version | `1.0.95`. |
| Resume by id | `-r, --resume [<value>]` accepts an id, task id, id prefix or name. `--session-id <id>` resumes an existing session or sets the UUID of a new one. `--continue` resumes the most recent session. |
| Session storage | `~/.codex/space-copilot/session-state/<uuid>/{events.jsonl, session.db, workspace.yaml, inuse.<pid>.lock, ...}` and `session-store.db`. Each profile is symlinked to the shared store by the wrapper. |
| Id discoverability | Deterministic in principle: pre-assign the UUID with `--session-id` on a fresh launch. `inuse.<pid>.lock` may also map a live PID to its session (unverified). |
| What Space does today | `--continue`. No id is recorded. |
| Admission | Sudoers admits `--run-inner --continue` only. The wrapper admits one-argument `--continue`. `--resume <id>` and `--session-id <id>` are refused. |
| Recommendation | Use pre-assignment with `--session-id <uuid>`, which serves both fresh launch and resume and so needs only one validated sudoers form. Record the UUID as `nativeTaskRef` at launch. |

### Hermes Agent

| Field | Finding |
| --- | --- |
| Installed version | `Hermes Agent v0.21.0 (2026.8.31)`, run from `~/.hermes/hermes-agent`. `cli-versions/hermes/current` is a dangling link to a missing `0.21.0` directory, and the wrapper does not use it. |
| Resume by id | `--resume SESSION`/`-r SESSION` accepts an id or title, or `latest`. `--continue [SESSION_NAME]` resumes by name or the most recent. |
| Session storage | `~/.hermes/state.db` (SessionDB) with the live registry `~/.hermes/runtime/active_sessions.json`. `~/.hermes/sessions/` holds request dumps only. |
| Id discoverability | Deterministic. `deploy/hermes-task-metadata.py` matches the registry's PID and `process_start_time` against the pane process tree and accepts ids matching `[A-Za-z0-9_-]{1,160}`. |
| What Space does today | `--continue`, which the wrapper turns into `hermes --tui --continue`. The task-title bridge learns the native id for title sync only. |
| Admission | Sudoers admits `--run-inner --continue` only. The wrapper has no argument filter. `--resume <id>` is refused by sudoers. |
| Recommendation | Root adds a validated `--resume <id>` sudoers entry, and the wrapper maps it to `hermes --tui --resume <id>`. Then persist the bridge's id into `nativeTaskRef` and add a gated `buildCliSpawnArgs` branch. The id format is only known from the bridge regex; confirm the native format before writing a stricter pattern. |

### OMP (Oh My Pi)

| Field | Finding |
| --- | --- |
| Installed version | `omp/18.6.3` at `/var/lib/spaceapp-user/.npm-global/bin/omp`. It was installed although the previous inventory recorded it as missing. |
| Resume by id | `-r, --resume=<value>` resumes by id prefix or path, and opens a picker when the value is omitted. `-c, --continue` continues the previous session. `--session-dir` sets the storage directory. |
| Session storage | `~/.omp/agent/sessions/--<cwd-slug>--/<ISO-timestamp>_<uuid>.jsonl`, with an optional sibling directory per session. |
| Id discoverability | Heuristic from the file name (cwd and start timestamp). No PID-keyed live registry was found by file name. |
| What Space does today | It launches bare `--resume`, which opens the picker. No id is recorded. |
| Admission | Sudoers admits `--run-inner --resume` only. The wrapper has no argument filter. `--resume <id>` is refused. |
| Recommendation | Low priority until OMP has a verified Space launch. The candidate is to give each pane its own `--session-dir`, which makes discovery deterministic, and then resume with `--resume=<uuid>`. This needs sudoers changes for both forms. |

### Qoder CLI

| Field | Finding |
| --- | --- |
| Installed version | `1.1.58` (`/usr/local/bin/qodercli`). |
| Resume by id | `-r, --resume [id]`: "Resume a previous session by identifier". `--session-id <id>`: "Use a specific session ID"; unverified whether it applies only to new sessions. `-c, --continue`: "Continue the most recent session". `--list-sessions` is also available. |
| Session storage | `~/.qoder/projects/<cwd-slug>/<uuid>.jsonl` and `<uuid>/state.json`, with logs in `~/.qoder/logs/sessions/<cwd-slug>/`. |
| Id discoverability | Pre-assignment with `--session-id` is possible but unverified. No PID-keyed live registry was found by file name. |
| What Space does today | Before this slice, RESUME launched bare `--resume`, which sudoers refuses, so the launch failed. The descriptor now declares `--continue`, which sudoers admits. No id is recorded. |
| Admission | Sudoers admits `--run-inner --continue` and `-c`. Bare `--resume` and `--resume <id>` are refused. The wrapper has no argument filter. |
| Recommendation | Verify the `--session-id` semantics offline. Then follow the Copilot pre-assignment design with a validated sudoers form. |

### Runtimes outside the nine

| Runtime | Installed version | CLI resume by id | Space today | Note |
| --- | --- | --- | --- | --- |
| Muse | `Muse Code 1.4.4` (inventory recorded 1.4.2) | `muse resume <session-ref>` takes an exact UUID or session name; `--last` resumes the latest. | No native resume. Sudoers admits only `--run-inner` and `--version`. | A CLI capability exists; Space support is a sudoers and design decision. |
| Droid | `0.234.0` | `-r, --resume [sessionId]`; `--last` with `--resume`. | No native resume. Sudoers admits only `--run-inner` and `--version`. | Same as Muse. |
| Autohand | `0.9.9-space.1` | Full id or native picker. | Source integration; `REFERENCE_PENDING_LIVE_PROOF`. | Isolated native-component proof passed; authenticated CLI proof and activation pending; later native errors can start fresh. |

## What remains open

- **Root-owned sudoers changes**, as validated regex entries, for each
  runtime that gets exact resume, and for DeepSeek's existing exact resume.
- **Live proofs**, for every runtime that is promoted to `REFERENCE`. Each
  proof runs in an Agent Proof room and shows the same native id before and
  after a host-loss restore and a task-history resume.
- **Gemini wrapper change** from the steered `--continue` to `--conversation
  <id>`: done 2026-10-30 with a live check of the wrapper path. A Space Agent
  Proof room proof is still open.
- **Persisting ids already discovered.** The Qwen and Hermes ids that the
  title bridge discovers still have to be written to `nativeTaskRef`.
