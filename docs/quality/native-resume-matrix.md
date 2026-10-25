# Native resume matrix (ADAPTER-006)

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
  - **Copilot and Grok:** pre-assignment changes every fresh launch.
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
   is one of the four runtimes counted as implemented. The live `sudo -l`
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
| What Space does today | It records the id as the session's `codexThreadId`, in the revision's `nativeTaskRef`, and in `/opt/spaceapp/var/gemini-pane-conversations/pane-<id>.json`. It launches `--continue` and passes the id in `SPACE_GEMINI_CONVERSATION_ID`, which the sudoers `env_keep` admits. The wrapper pre-seeds `cache/last_conversations.json` with that id for the workspace and copies the conversation database into the active profile, so `--continue` targets it. Task-history resume reports `NATIVE_RESUME`. Exactness depends on undocumented `--continue` internals: unverified live. |
| Admission | `--run-inner --continue` is admitted. `--run-inner --conversation <id>` is refused by sudoers and by the wrapper filter. |
| Recommendation | Keep the API arguments at `--continue` and change only the wrapper's inner exec: when `SPACE_GEMINI_CONVERSATION_ID` is a valid UUID and `conversations/<id>.db` exists in the active state root, exec `agy --dangerously-skip-permissions --conversation <id>`; otherwise keep `--continue`. This needs no sudoers change because the id already travels in a kept environment variable. Declare `REFERENCE` only after a live proof in an Agent Proof room shows the same conversation id before and after a host-loss restore. |

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
| Autohand | `0.9.6-space.1` | Unverified: `--help` printed nothing under the isolated probe. | No native resume. | Needs a TTY-attached help probe. |

## What remains open

- **Root-owned sudoers changes**, as validated regex entries, for each
  runtime that gets exact resume, and for DeepSeek's existing exact resume.
- **Live proofs**, for every runtime that is promoted to `REFERENCE`. Each
  proof runs in an Agent Proof room and shows the same native id before and
  after a host-loss restore and a task-history resume.
- **Gemini wrapper change** from the steered `--continue` to `--conversation
  <id>`, with a live proof.
- **Persisting ids already discovered.** The Qwen and Hermes ids that the
  title bridge discovers still have to be written to `nativeTaskRef`.
