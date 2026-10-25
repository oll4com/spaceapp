# Runtime compatibility and context ownership

The host IPC protocol and runtime descriptors already provide useful boundaries.
They do not prove that every provider supports the same lifecycle operations.
No provider version was installed into the managed versions tree or promoted
during these slices.

For every advertised provider, the final matrix must record these independent
facts at the same candidate SHA:

| Field | Required evidence |
| --- | --- |
| Provider and CLI version | Exact installed executable version, runtime image digest |
| start/send/interrupt | Actual task input and observed response/interruption |
| native resume/reconnect | Native task ID before/after, real process and DB/WebSocket evidence |
| unsupported operation | Explicit structured unsupported result, no generic fallback pretending equivalence |
| context ownership | Provider-native compaction vs Space-managed retrieval; avoid a second compaction layer |
| token/cost availability | Measured provider usage, labelled estimate, or unavailable; opaque usage is not zero cost |
| continuation | Persisted goal/decisions/constraints/evidence references and actual long-session test |
| limits | Mission/turn/time/cost stopping behavior and safe retry semantics |

Current status (2026-10-11): the **adapter contract suite** covers all 16
advertised runtimes, every runtime that cannot provide an operation **declares
a structured limitation**, the **scheduled canary** exists as a script plus
repository-only systemd units, and the **compatibility matrix** below records
exact versions from isolated probes. Live evidence is still missing: no real
session, login or provider request ran, so every "live" cell is unverified.

The registry exposes an optional `cliAdapter` version-1 declaration for all 16
CLI descriptors. It describes the existing start/send/interrupt/inspect/events/
reconnect boundary, native resume modes, completion observation and, since this
slice, an optional `limitations` list. Older registry records without either
field remain valid; an unknown supplied contract version is rejected.

Declarations are **not authorization or live compatibility evidence**. Existing
runtime availability, authentication, feature policy and control leases still
admit operations. A disabled runtime can describe its adapter without being
launchable. No discovery-time CLI version probe or provider request was added.

## Adapter contract suite

`apps/api/tests/cli-adapter-runtime-contract.test.ts` runs for **every**
descriptor in `cliRuntimeDescriptors`. Each fact is derived from the launcher
(`buildCliSpawnArgs`, `buildCliEnvironment`), the lifecycle adapter and the
repository launch gates, never from the declaration itself:

- **Operations.** The registry publishes all six operations for each runtime,
  and its `limitations` equal the descriptor's.
- **Start.** The fresh-start argv passes the wrapper filter
  (`require_allowed_args`) and the sudoers `Cmnd_Alias`. A start that the
  launcher refuses without a resolved model is allowed only with
  `START_REQUIRES_RESOLVED_MODEL` (Codex).
- **Native resume.** The provider-selection argv equals `nativeResumeArgs` and
  is admitted. `REFERENCE` is declared exactly when `declaresNativeReference`
  is set, and never for a launcher that cannot pass a recorded reference. Every
  reference argv the launcher can emit is admitted by both gates. A reference
  carried in an environment variable must be in the sudoers `env_keep`.
- **Login.** A `login` action runs `login` through both gates and belongs to an
  interactive auth mode; a runtime without one rejects LOGIN with
  `CLI_LOGIN_UNAVAILABLE`, has auth mode `NONE` or `MANAGED`, and no bootstrap.
  The credential-observation action is admitted.
- **Launch hand-off.** The account-profile and pane-model variables the
  launcher sets are exactly the descriptor's `accountProfileEnv` and
  `paneModelLaunchEnv`, and sudoers keeps them.
- **Limitations.** The declared limitation codes must equal the set the facts
  imply; a missing or stale limitation fails the suite.
- **Canary hand-off.** The declared launch forms are written to
  `scripts/cli-launch-forms.json` (a file snapshot; `vitest -u` regenerates
  it), which the canary reads without loading TypeScript.

The shared gate helpers live in `scripts/cli-launch-admission.mjs` and are used
by this suite, by `cli-resume-launch-admission.test.ts` and by the canary.

| Limitation code | Operation | Runtimes |
| --- | --- | --- |
| `START_REQUIRES_RESOLVED_MODEL` | start | Codex |
| `NATIVE_RESUME_UNSUPPORTED` | nativeResume | Autohand |
| `PROVIDER_SELECTION_ONLY` | nativeResume | Gemini, Qwen, Kimi, Grok, Cursor, Copilot, Hermes, OMP, Qoder, Muse, Droid |
| `PROVIDER_SELECTION_INTERACTIVE_PICKER` | nativeResume | Claude (bare `--resume`), Kimi (`--session`) |
| `REFERENCE_PENDING_LIVE_PROOF` | nativeResume | Qwen (`--resume <uuid>`), Qoder (`-r <uuid>`, fresh `--session-id <uuid>`) |
| `REFERENCE_STEERED_BY_WRAPPER` | nativeResume | Gemini (`SPACE_GEMINI_CONVERSATION_ID`) |
| `HOST_LOSS_RESTARTS_FRESH` | reconnect | Autohand |
| `COMPLETION_UNOBSERVED` | completion | all except Codex and OpenCode |
| `LOGIN_NOT_IN_TERMINAL` | login | OpenCode, Gemini, Hermes, OMP, Qoder, Muse, Droid |

Provider selection does not prove recovery of the same native task. A
live-host reconnect retains a process; it is distinct from spawning a process
that resumes provider-native history. `interrupt` describes the existing
process-termination operation, not a provider-specific graceful turn
cancellation. PTY output and process exit events do not independently establish
task success.

The declaration also identifies provider-native context ownership and absence
of a second Space compaction layer at the PTY boundary. Normalized per-turn
usage reporting there is unavailable; this does not deny usage on separate
account or rollout surfaces, and does not imply zero cost.

## Where provider-specific code may live

Changing or adding a provider must not add `runtime.id === "cli:..."` branches
to a central route handler. The rule, enforced by the contract suite:

| Concern | Lives in |
| --- | --- |
| Argv for start, resume and login | `buildCliSpawnArgs` (`cli-terminal.ts`); its per-runtime resume branches are the adapter layer |
| Variables the wrapper reads | Descriptor fields `environment`, `accountProfileEnv`, `paneModelLaunchEnv`, `loginBootstrapRuntimeEnv` |
| Exact task-history resume reference | A resolver in `cli-native-task-resume.ts` |
| Declared modes and limitations | Descriptor fields `nativeResumeArgs`, `declaresNativeReference`, `adapterLimitations` |
| Launch admission | `deploy/<cli>-vscode-parity` filter and `deploy/space-<cli>-vscode-parity.sudoers` |

Moved behind the adapter on 2026-10-11, without behavior change:

- `resumePaneCliTask` and the Room Agent `resumeCli` no longer branch per runtime.
  The OpenCode, Gemini, DeepSeek, Claude and Qoder reference resolution, the
  Gemini pane-conversation write and the OpenCode audit field come from
  `resolveNativeTaskResume` (`apps/api/tests/cli-native-task-resume.test.ts`).
  Codex keeps its explicit path because only its thread references carry
  Space-owned thread claims and history attachment.
- `buildCliEnvironment` reads the account-profile variable and the pane-model
  hand-off from the descriptor instead of two runtime-id lists. The
  account-profile runtime list moved to `cli-runtime-descriptors.ts`, and the
  model-catalog profile scope uses the descriptor.

Still provider-specific in `app.ts`, outside this package's scope: Gemini
conversation binding and Claude account-switch resume in the session start
route, per-provider account-profile readers, native mode lists, quota and
Gemini input-readiness handling.

## Scheduled canary

`scripts/cli-canary.mjs` checks a candidate upstream CLI version before anyone
promotes it. It never promotes, never touches a `current` link, never starts a
session, login or provider request.

1. **Stage in isolation.** A managed CLI's candidate is installed with the
   reviewed `installCliCandidate` (the same pinned installers and integrity
   checks the maintenance update uses) into
   `/var/lib/spaceapp-user/agent-workspace/cli-canary/stage/<cli>-<version>-<random>`.
   The stage root is refused inside `/opt/spaceapp` or the managed versions tree.
   Staging may only run `curl`, `tar`, `unzip`, `sha256sum`, `sha512sum` and
   `npm install|ci --ignore-scripts`; `chown` is skipped. The stage is removed
   afterwards unless `--keep-stage` is given.
2. **Probe offline.** Every candidate execution runs
   `timeout 60 unshare -Un --map-current-user env -i HOME=<empty scratch> ...`,
   so a CLI that phones home finds only a down loopback interface. Probes are
   `--version` and `--help` style only.
3. **Parse the flags Space relies on.** Per runtime, the canary requires the
   resume/continue/session flags, model flags, login subcommands and fixed TUI
   flags the wrappers pass. Flags a CLI hides from help count only if the same
   parser rejects an unknown control flag; otherwise they are `UNVERIFIED`.
4. **Check the launch gates.** Every declared argv in
   `scripts/cli-launch-forms.json` must pass the repository wrapper filter and
   sudoers rule, and every hand-off variable must be in `env_keep`.
5. **Write a verdict.** `PASS`, `PASS_WITH_UNVERIFIED`, `FAIL` or `BLOCKED`
   (isolation unavailable, unmanaged CLI, install failure, reviewed patch
   rebase required), always `promotion: NOT_PERFORMED`, to
   `/var/lib/spaceapp-user/agent-workspace/reports/cli-canary/<timestamp>-<cli>-<version>.json`.

Modes: `--cli <key> --version <v>` (one candidate), `--cli <key> --binary <path>`
(an already staged binary, for the five CLIs Space does not version), `--scheduled`
(every managed CLI whose stable version differs from its `current` target) and
`--inventory` (the binaries the wrappers resolve today). Tests:
`node --test scripts/tests/cli-canary.test.mjs` (13 tests, including an
end-to-end run of a fake binary inside the namespace).

Sample verdict, `20261011T151758Z-codex-0.162.1.json`: candidate `0.162.1`
staged from npm, reported `0.162.1`, 23 checks (version, 17 upstream flags, 4
launch forms through both gates), verdict `PASS`, recommendation
`ELIGIBLE_FOR_REVIEWED_PROMOTION`, `promotion: NOT_PERFORMED`; the live
`codex/current` link still read `0.152.0` afterwards.

**Installed on public-host on 2026-10-16** (not by a deploy; next run Sunday 04:30 local).
The first run (`systemctl start space-cli-canary.service`, 16 s) checked the three
managed CLIs with a newer stable version: Codex `0.163.0` `PASS`, Gemini `1.4.0`
`PASS`, Qwen `0.25.2` `BLOCKED` (`PATCH_REBASE_REQUIRED`: the reviewed Space patch
must be rebased first). Nothing was promoted.

`deploy/space-cli-canary.service` runs `--scheduled` weekly as `spaceapp-user`
with `Nice=10`, `ProtectSystem=strict`, `ProtectHome=read-only` and only the
canary and report directories writable. An operator installs it with:

```sh
install -d -o spaceapp-user -g spaceapp-user -m 0750 /var/lib/spaceapp-user/agent-workspace/cli-canary /var/lib/spaceapp-user/agent-workspace/reports/cli-canary
sudo install -m 0644 deploy/space-cli-canary.service deploy/space-cli-canary.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now space-cli-canary.timer
```

Unprivileged user namespaces must stay enabled; without them every run records
`BLOCKED: ISOLATION_UNAVAILABLE` and probes nothing.

## Compatibility matrix, 2026-10-11

Versions come from the canary inventory
`/var/lib/spaceapp-user/agent-workspace/reports/cli-canary/20261011T161658Z-inventory.json`
(repository commit `e05e49596c`): the binary each repository wrapper resolves when sourced, probed with
`--version` and `--help` in a private network namespace with an empty HOME.
All 16 inventories passed their flag and launch-gate checks (Cursor:
`PASS_WITH_UNVERIFIED`, see below).

| Runtime | Version reported | Binary the wrapper runs | Managed `current` |
| --- | --- | --- | --- |
| OpenCode | 1.19.0 | `cli-versions/opencode/current` | 1.19.0 |
| Codex | 0.162.1 | `/usr/local/bin/codex` (legacy fallback, shim to `~/.npm-global/bin/codex`) | 0.152.0, **dangling** |
| Claude Code | 2.1.296 | `cli-versions/claude/current` | 2.1.296 |
| Gemini (Antigravity `agy`) | 1.3.3 | `cli-versions/gemini/current/agy` | directory 1.3.1 |
| Autohand | 0.9.6 (`0.9.6 (3f25e12)`) | `cli-versions/autohand/current` | 0.9.6-space.1 |
| Qwen Code | 0.23.2 | `cli-versions/qwen/current` | 0.23.2-space.1 |
| Kimi Code | 2.1.1 | `cli-versions/kimi/current` | 2.1.1 |
| Grok Build | 1.0.50 (`c58f321264ba`) | `cli-versions/grok/current` | 1.0.50 |
| DeepSeek (Reasonix) | 2.35.0 | `cli-versions/deepseek/current` | 2.35.0 |
| Cursor | 2026.10.01-e373342 | `cli-versions/cursor/current` | 2026.10.01-e373342 |
| GitHub Copilot | 1.0.95 | `cli-versions/copilot/current` | 1.0.95 |
| Hermes Agent | 0.21.0 (2026.8.31) | `~/.hermes/.local/bin/hermes` | 0.21.0, **dangling** |
| OMP | 18.6.3 | `~/.npm-global/bin/omp` | not managed |
| Qoder | 1.1.58 | `/usr/local/bin/qodercli` | not managed |
| Muse Code | 1.4.4 (1.4.4-R5419.1) | `~/.local/bin/muse` launcher | not managed |
| Droid | 0.238.0 | `~/.local/bin/droid` | not managed |

**OpenCode 2 (`@opencode/cli`), 2026-10-16.** Space supported both majors until OpenCode 1 was retired on 2026-10-18
(plan `clipboard:kJ1BIeylJRLG`); it now speaks OpenCode 2 only. Stable runs OpenCode 2.0.32 since the
cutover of 2026-10-17, which migrated 1171 sessions in 22 s (`docs/runbooks/opencode-2-cutover.md`).
- **Canary:** passes for 2.0.31 (`cli-canary --binary`, OpenCode 2 expectations: `--server`, `--standalone`,
  `--session`, `run --format/--title/--model`).
- **Verified in isolation on 2.0.31:**
  - the v2 API (Basic user `opencode`),
  - the pane launch (`--server`) with a live TUI,
  - a Big Pickle real tool call through the API and through `run --standalone`,
  - a model switch that the TUI follows,
  - interrupt,
  - native titles,
  - the free-model picker.
- **Existing sessions:** OpenCode 2 migrates the v1 history only once `GET /api/experimental/migration/v1` is read. On a
  copy of the real store this moved all 1168 sessions in 176 s; OpenCode 1 still reads the migrated store.
- **Stable-host rehearsal 2026-10-17:** stable's wrapper, launcher, daemon and control package passed with the staged
  2.0.31 against a store copy on a port of its own: pane, resume, fallback, updater checks, tool call, model switch,
  interrupt. Evidence: `reports/opencode-v2/phase8-stable-rehearsal.json`. The credential smoke needed stdin closed
  (`186b7bbee7`): OpenCode 2's `run` waits for EOF.

Evidence types: **CT** contract test (`cli-adapter-runtime-contract.test.ts`;
for send/interrupt/reconnect the runtime-agnostic PTY host tests
`packages/cli-host/tests/ipc.test.ts`, `session-registry.test.ts` and
`apps/api/tests/cli-terminal-control.test.ts`), **SA** static admission
(repository wrapper filter + sudoers), **UF** upstream flag probe of the exact
version above, **LP** live proof on stable, **U** unverified. The LP entries are
from 2026-10-16 on stable `fda4aae81a` (see "Live runtime proofs, 2026-10-16"
below): **(I)** the authenticated `PROVE_CLI_INPUT` browser proof, **(R)**
`PROVE_CODEX_RESUME`, **(C)** Space Control (`space-admin-action control`) on a real
pane.

**Live start proofs, 2026-10-14 (stable, `ADD_*_CLI` through the authenticated
proof backend, disposable Agent Proof rooms, all deleted afterwards; reports in
`20261014-runtime-start-proofs`):**

- Gemini: the launcher created the pane, the session reached `RUNNING` (`cli:gemini`, purpose `NORMAL`) and the
  account picker listed 10 profiles. The proof still reported failure, because the
  web asked `/working-time` for the temporary `pane:optimistic-*` id (404), fixed in
  `de2f1ab379`. The first run also overlapped a stable API restart (502s).
- Claude Code: failed: its `/model` picker was still loading (`models_pending`)
  when the proof compared it with the provider catalog.
- Qwen Code, Kimi Code, Grok Build, Cursor, GitHub Copilot and Autohand Code:
  not run, because they are disabled in the operator's CLI runtime settings.

These are start-only (visual/control) proofs: no prompt was sent, so they say
nothing about execution or resume.

**Live runtime proofs, 2026-10-16 (stable `fda4aae81a`; reports in
`20261016-runtime-live-proofs`; every proof room deleted and every pane closed
afterwards):**

- **Codex and Claude Code, `PROVE_CLI_INPUT` (I).** A new single-pane proof room
  started the CLI; the browser typed a draft with edits and a paste, submitted it,
  and the model answered the exact uppercase value (`matchedAfterSubmit`, from the
  transcript). Session, PID and generation stayed the same across a 15 s dwell
  and a page reload that re-attached the terminal at the same geometry. The
  evidence validator (`cliInputProofEvidenceIsValid`) accepts both. The proof's
  overall `ok` was false only because the page also asked for the browser handoff
  of a pane in another room whose handoff had expired (404); since `f3d78ee1a6`
  the proof counts that like the closed-pane 409 it already accepted.
- **Codex resume, `PROVE_CODEX_RESUME` (R).** The resume picker opened and was
  dismissed; session and PID stayed the same and the terminal re-attached.
- **Re-run after the promote to stable `2facc3b779` (same day):** `PROVE_CLI_INPUT`
  for Codex and Claude Code and `PROVE_CODEX_RESUME` all report `ok: true`. One of
  two resume attempts failed first ("Codex /resume picker did not open").
- **OpenCode, Space Control (C).** A pane started in the operator's room; a
  prompt got the exact answer; a stop during a `sleep 150` tool call left the
  task `INTERRUPTED` (confirmed after about 25 s; Space Control's own 3.5 s
  confirmation reported `UNKNOWN`), and the next prompt was answered in the same
  session. The browser-typed proof failed twice for OpenCode: the CLI wrote
  57 KB after the submit but the expected value never appeared contiguously in
  the transcript within 137 s, and the proof read the rendered screen only for
  Gemini. OpenCode 1.19.2 in tmux with a throwaway home shows the answer
  contiguously on its screen, so since `98eb7d2339` the proof reads OpenCode's
  screen too; the re-proof waits for the promote.
- **Codex interrupt (C): failed.** A Space Control stop during a long tool call
  answered "did not become ready for input before the startup timeout" and the
  turn ran to completion: the Esc fallback waited for Codex's ready composer,
  which a busy Codex never shows. Fixed on dev by sending interrupt keys without
  that wait (queued 2026-10-16, `apps/api/tests/cli-composer-readiness.test.ts`);
  the live re-proof waits for the promote.
- **Not proven:** Gemini (`PROVE_CLI_INPUT` found no account with 5-hour and
  weekly quota above 1%); `ADD_CLAUDE_CODE_CLI` and `ADD_GEMINI_CLI` (the proof
  room was not created or did not become ready, twice); Hermes and the runtimes
  disabled in the operator's settings; host-loss resume for every runtime.

| Runtime | start | send | interrupt | native resume | reconnect |
| --- | --- | --- | --- | --- | --- |
| OpenCode | CT SA UF; LP pass (C) | CT; LP pass (C), browser-typed LP fail (see below) | CT; LP pass (C) | REFERENCE + provider selection: CT SA UF; LP U | live host CT; host loss resumes (CT); LP U |
| Codex | CT SA UF (resolved model required); LP pass (I) | CT; LP pass (I) | CT; LP fail (C), fix queued | REFERENCE (thread): CT SA UF; resume picker LP pass (R) | live host CT; host loss resumes once a thread is bound; browser reattach LP pass (I) |
| Claude Code | CT SA UF; LP pass (I) | CT; LP pass (I) | CT; LP U | REFERENCE + picker fallback: CT SA UF; LP U | live host CT; host loss resumes; browser reattach LP pass (I) |
| Gemini | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection, wrapper-steered reference: CT SA (env_keep) UF; exactness U | live host CT; host loss resumes; LP U |
| Autohand | CT SA UF; LP U | CT; LP U | CT; LP U | unsupported (declared) | live host CT; host loss resumes the recorded or index-resolved task (CT), fresh only when none is found |
| Qwen | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection; reference passed, pending live proof: CT SA UF | live host CT; host loss resumes; LP U |
| Kimi | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection (picker): CT SA UF; LP U | live host CT; host loss resumes; LP U |
| Grok | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| DeepSeek | CT SA UF; LP U | CT; LP U | CT; LP U | REFERENCE (task history): CT SA UF; LP U | live host CT; host loss restarts fresh (declared) |
| Cursor | CT SA UF (`--disable-auto-update`: upstream source, see below); LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| Copilot | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| Hermes | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| OMP | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| Qoder | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection; reference passed, pending live proof: CT SA UF | live host CT; host loss resumes; LP U |
| Muse | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| Droid | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |

Findings from the inventory and the contract suite:

- **Codex's managed link is dangling.** `cli-versions/codex/current` points at a
  missing `0.152.0`, so the wrapper falls back to `/usr/local/bin/codex` 0.162.1.
  The earlier inventory recorded 0.152.0 from the link. A reviewed maintenance
  run, not the canary, has to restore it; the canary verdict for 0.162.1 is
  `PASS`.
- **Gemini's binary reports 1.3.3** in directory `1.3.1`, and Hermes' link is
  dangling while the wrapper runs `~/.hermes` (both known).
- **Autohand prints help after about 20 s offline.** The earlier 15 s probe was
  too short; it is not missing. The canary uses 60 s.
- **Copilot accepts `--effort`** (the wrapper's model flag) as a hidden alias
  of `--reasoning-effort`; Grok accepts the hidden `--no-auto-update`. Both were
  checked against a parser that rejects unknown flags. Cursor's hidden
  `--disable-auto-update` cannot be checked by the parser probe (its parser accepts
  any flag). Checked in the shipped bundle instead (2026-10-16, `2026.10.14-941492e`):
  the option is declared (`index.js`, hidden "Disable auto-updates") and the agent
  starts its background update check only when `disableAutoUpdate` is false and the
  channel is not `static` (`7000.index.js`). The managed version directories are
  root-owned and changed only through reviewed maintenance installs.
- **Qwen's task-history resume does not pass its recorded reference.** Only
  the host-loss restore passes `--resume <uuid>`; task history starts a fresh
  session with Space context (no resolver in `cli-native-task-resume.ts`).
- **Qoder's sudoers admits `-r *` and `--session-id *`.** A sudoers `*` also
  matches spaces and the wrapper has no filter, so the gate admits extra
  arguments; only the API's UUID pattern constrains the reference. An anchored
  regex like Qwen's would close it (root-owned, not changed here).
- **DeepSeek after a pane-host loss (fixed 2026-10-12).** The restore now resumes the
  task's recorded native reference, or the one the Reasonix session index matches (the
  same resolver as task-history resume), with `--resume <ref>`. Without a match it
  still starts fresh, since no provider-selection form exists. Test:
  `cli-runtimes.test.ts` "resumes the exact recorded DeepSeek task after actual host loss".
- **The declaration policy is uneven.** Claude and DeepSeek declare
  `REFERENCE` without a live proof, while Qwen and Qoder withhold it pending
  one.

## Live evidence, 2026-10-12

Authenticated UI proofs on live (`space_authenticated_ui_proof`, reports under
`/var/lib/spaceapp-user/agent-workspace/reports/20261012-runtime-proofs/`):

| Proof | Result | What it shows |
| --- | --- | --- |
| `PROVE_CODEX_RESUME` | pass | The Codex resume picker opens and is dismissed with the same session and PID; the terminal re-attaches |
| `OPEN_CLI_TASK_HISTORY` | flow passes; overall `ok=false` | Exact task match, selection replaces the target session, the logical task is kept, the revision advances and the terminal attaches (mode `SPACE_FALLBACK` for the fixture panes). The run is marked not ok only for two expected `404` "not found" replies (no browser handoff request; dashboard poll of the room being deleted) |
| `ADD_*_CLI` (8 runtimes) | not run | The proof account is the operator, whose room toolbar is hidden; the proof uses only the toolbar launcher (the collapsed rail opens panes in an isolated worktree) and proofs never change the account's toolbar setting |

Real use on live in the 7 days to 2026-10-12 (`pane_cli_sessions`, purpose `NORMAL`,
counts only, read-only query):

| Runtime | Sessions started | Running at the query | `RESUME` launches |
| --- | --- | --- | --- |
| `cli:claude` | 60 | 14 | 4 |
| `cli:codex` | 2 | 0 | 0 |
| `cli:hermes` | 1 | 0 | 0 |

No other runtime started a PTY session in that window, so their start, resume and
reconnect columns above remain contract-only evidence. Several need a provider login or
quota the host does not have (for example Qwen quota is exhausted and Gemini has no
authenticated account), which is a provider-account limit, not a Space defect.

## History

- **2026-10-03.** Four `--version` probes on the task host PATH: codex 0.160.0,
  claude 2.1.206, gemini 0.37.1, opencode 1.18.34 (host executables only).
- **2026-10-11, morning.** The managed-link inventory recorded the versions the
  links named (Codex 0.152.0, OpenCode 1.18.35, DeepSeek 2.33.0 and others);
  the native resume research (`native-resume-matrix.md`) corrected OMP (installed,
  18.6.3), Gemini (1.3.3), Muse (1.4.4) and Hermes (dangling link). The table
  above supersedes both.
- Descriptor/login admission for all 16 CLIs, the supported-login lifecycle
  suite (22 tests) and the 4 MiB bounded provider catalogs (8 tests) are
  unchanged; they use synthetic executables and establish Space policy, not
  provider login compatibility. Configured fallback model names are not a live
  provider inventory.
