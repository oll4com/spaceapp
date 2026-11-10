# Runtime compatibility and context ownership

## Droid and Autohand sweep, 2026-11-04 (ADAPTER-006)

Read-only, network-isolated help/version probes confirm native resume-by-id in
both installed CLIs: Droid `0.244.0` (`--resume [sessionId]`), Autohand
`0.9.9 (ec2372d5)` in controlled `0.9.9-space.1`
(`--resume [reference]`). Their ids appear in
`~/.factory/sessions/<cwd-slug>/<uuid>.jsonl` and
`~/.codex/space-autohand/sessions/<uuid>-<timestamp>/` respectively.
Only masked native paths were listed; no native file contents were read.

Droid now has exact-ID source launch/resolution/persistence and anchored launch
admission. Its path-only capture requires the pane's actual Droid executable to
hold one writable session JSONL descriptor; fixtures verify its refusal rules,
but the installed CLI's descriptor lifetime and reliable capture remain unproven.
No descriptor yields no id. Exact launches refuse missing, ambiguous or
symlinked paths; without a valid recorded id, provider selection stays
`--resume --last`. Autohand's existing full-ID integration stays unchanged.

Both remain `REFERENCE_PENDING_LIVE_PROOF` with
`declaresNativeReference=false`: **14/16 declarations; ADAPTER-006 partial**.
Neither is accepted as an upstream no-resume tradeoff. Activation through the
normal release path and authenticated native/process/DB/WebSocket evidence
remain open; these probes made no login, provider request, host restart,
Warm change or promote. See the [dated native resume probe](native-resume-matrix.md#read-only-sweep-2026-11-04-droid-and-autohand)
for exact output and evidence paths.

## Autohand resume integration, 2026-11-03 (ADAPTER-006)

Autohand `0.9.9-space.1` now has source wiring for a process-bound native
`UUID-timestamp` reference, plus the native picker without a reference. Its
capability remains `REFERENCE_PENDING_LIVE_PROOF`, `declaresNativeReference=false`:
14 of 16 runtimes declare `REFERENCE`, not 14 authenticated proofs. The isolated
installed-component fixture proved A versus newer B and rejected native cwd
collisions across both resolution stages; it did not run an authenticated CLI.
Preflight rejects invalid saved state, but upstream can create fresh after later
resume errors. Activation, account sign-in and authenticated process/DB/WebSocket
proof remain pending. See the [native resume matrix](native-resume-matrix.md#autohand-source-integration-2026-11-03-adapter-006-live-proof-pending)
for binding, safeguards, native limits and evidence.

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
| `NATIVE_RESUME_UNSUPPORTED` | nativeResume | none |
| `PROVIDER_SELECTION_ONLY` | nativeResume | Droid, Autohand (exact-reference proof pending) |
| `PROVIDER_SELECTION_INTERACTIVE_PICKER` | nativeResume | Claude and Autohand (bare `--resume`), Kimi (`--session`) |
| `REFERENCE_PENDING_LIVE_PROOF` | nativeResume | Droid, Autohand |
| `REFERENCE_STEERED_BY_WRAPPER` | nativeResume | Gemini (`SPACE_GEMINI_CONVERSATION_ID`; the wrapper launches `agy --conversation <id>`), Copilot (`SPACE_COPILOT_SESSION_ID`; the wrapper launches `copilot --session-id <id>`), Grok (`SPACE_GROK_SESSION_ID`; the wrapper launches `grok --session-id <id>` fresh, `grok --resume <id>` once stored), Cursor (`SPACE_CURSOR_SESSION_ID`; the wrapper launches `cursor-agent --resume <id>` fresh and once stored) |
| `HOST_LOSS_RESTARTS_FRESH` | reconnect | none |
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

**The maintenance update now waits for it (2026-10-29, ADAPTER-001).** `updateCliRuntime` in
`scripts/cli-maintenance-updater.mjs` runs the canary's flag checks on every staged candidate after the doctor and
before `current` moves: `runuser -u spaceapp-user -- node scripts/cli-canary.mjs --cli <key> --binary <staged binary>`.
Only `PASS` and `PASS_WITH_UNVERIFIED` activate; `FAIL`, `BLOCKED`, a canary that does not run or a verdict that cannot
be read keep the previous `current`, remove the staged version and answer `CANARY_FLAGS_FAILED` with the failing flags.
The doctor's `--version` probe through the wrapper never ran the launch flags, so Copilot 1.0.105 (which removed
`--no-remote`) became `current` on 2026-10-28 and no Copilot pane started. Proof on that real binary, staged in a
scratch versions root: with the canary of 2026-10-28 the update answers `CANARY_FLAGS_FAILED` ("LAUNCH --no-remote
(--help); LAUNCH --no-remote-export (--help)") and `current` stays 1.0.104; with today's canary (the wrapper no longer
passes `--no-remote`) it activates 1.0.105. The Qwen controlled install and the Cursor/Copilot installer go through the
same update. Since 2026-10-29 (slice A) the two other paths are gated too: a CLI that updated itself in place (Gemini) has
its version folder adopted only when its flags pass, else the maintenance result is `CANARY_FLAGS_FAILED` (outcome
`DEGRADED`: the self-updated bytes already run) and `current` keeps its old folder; the Hermes updater runs the canary on
the updated Hermes before it keeps the update and restores the whole home from its copy on a refusal (`CANARY_FLAGS_FAILED`). Tests: the three canary-gate cases in `scripts/tests/cli-maintenance-updater.test.mjs`.

**Installed on public-host on 2026-10-16** (not by a deploy; next run Sunday 04:30 local).
The first run (`systemctl start space-cli-canary.service`, 16 s) checked the three
managed CLIs with a newer stable version: Codex `0.163.0` `PASS`, Gemini `1.4.0`
`PASS`, Qwen `0.25.2` `BLOCKED` (`PATCH_REBASE_REQUIRED`: the reviewed Space patch
must be rebased first). Nothing was promoted.

**Qwen rebased onto 0.26.1 on 2026-10-28** (ADAPTER-001): the reviewed patch (Kitty response window 200 ms to
1,500 ms) moved to 0.26.1's minified `chunks/chunk-HKA2IEQ6.js`, now `0.26.1-space.1` with the sharp 0.35.5 override
kept; `deploy/qwen-task-metadata.mjs` accepts 0.26.1, whose `SessionService` keeps the constructor and the two methods
Space calls (the opt-in real-module case of `task-title-native.test.mjs` passes on it). The canary, run from the change's
worktree, gave `0.26.1-space.1` `PASS` (19/19, `ELIGIBLE_FOR_REVIEWED_PROMOTION`). The activation baseline stays `0.23.2`
and the live `0.23.2-space.2` is the previous patched version, so the controlled installer upgrades from it and rolls back
to it. The scheduled maintenance never installs Qwen; the deploy that brings these inputs to stable does
(`install-qwen-cli.mjs --confirm-live-write`), once stable's live deploy pins name them (a stable hotfix, as for
0.23.2-space.2 on 2026-10-24).

**Qwen rebased onto 0.26.6 on 2026-11-03** (ADAPTER-001; the scheduled canary blocked 0.26.6 with `PATCH_REBASE_REQUIRED`):
0.26.6 keeps `chunks/chunk-HKA2IEQ6.js` byte-identical (pre-image `768e031a…`), so the reviewed Kitty-window patch is
unchanged; SRI (equal to the registry's), SHA-256 `6d6889ae…` and git head `042c023b7b` are re-pinned as `0.26.6-space.1`.
0.26.6 still pins sharp 0.35.4, so the 0.35.5 override stays (npm audit of the new lock: 0 vulnerabilities).
`deploy/qwen-task-metadata.mjs` accepts 0.26.6 (the real-module case of `task-title-native.test.mjs` passes on the staged
0.26.6). The baseline stays `0.23.2`; the live `0.26.1-space.1` becomes the previous patched version the installer upgrades
from and rolls back to. The canary from the change's worktree: `0.26.6-space.1` `PASS` 19/19,
`ELIGIBLE_FOR_REVIEWED_PROMOTION`. As on 2026-10-28, stable's live deploy refuses the new inputs until a stable hotfix moves
its three Qwen pins (`qwen_package_json_sha256`, `qwen_package_lock_sha256`, `qwen_patcher_sha256`); that hotfix lands
before the promote that carries this change.

**Autohand rebased onto 0.9.9 on 2026-11-03** (ADAPTER-001; the scheduled canary of 2/11 blocked 0.9.9 with
`PATCH_REBASE_REQUIRED`): both patched chunks of 0.9.9 (`chunk-MM4RDHSM.js`, `chunk-IFC7EBK3.js`) are byte-identical to
0.9.8's, so the patch is unchanged; tarball SRI (equal to the registry's), SHA-256 and git head `ec2372d5eb` are re-pinned
as `0.9.9-space.1`. 0.9.9 still pulls node-llama-cpp 3.22.1 with simple-git ^3.36.0, so the simple-git 4.0.2 override
stays (npm audit of the new lock: the same 4 moderate findings as 0.9.8's, all inside autohand-cli's own minimatch and
node-notifier ranges). The canary from the change's worktree: `0.9.9-space.1` `PASS` 12/12. CLI maintenance installs it
on stable after the promote.

`deploy/space-cli-canary.service` runs `--scheduled` weekly as `spaceapp-user`
with `Nice=10`, `ProtectSystem=strict`, `ProtectHome=read-only` and only the
canary and report directories writable. Since 2026-10-28 (ADAPTER-001) every deploy installs and enables it and creates
its two folders, and System Health shows a "CLI canary" check: each CLI's newest verdict, a warning for a BLOCKED, FAIL,
PASS_WITH_UNVERIFIED or 9-day-old one (`apps/api/src/cli-canary-health.ts`, the same rules as
`scripts/space-cli-canary-status.mjs`, shared in `@space/runtime`). By hand it was:

```sh
install -d -o spaceapp-user -g spaceapp-user -m 0750 /var/lib/spaceapp-user/agent-workspace/cli-canary /var/lib/spaceapp-user/agent-workspace/reports/cli-canary
sudo install -m 0644 deploy/space-cli-canary.service deploy/space-cli-canary.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now space-cli-canary.timer
```

Unprivileged user namespaces must stay enabled; without them every run records
`BLOCKED: ISOLATION_UNAVAILABLE` and probes nothing.

## Canary inventory, 2026-11-03

`node scripts/cli-canary.mjs --inventory` from repository commit `9a22289001`
(`/var/lib/spaceapp-user/agent-workspace/reports/cli-canary/20261103T161839Z-inventory.json`), same isolation as below: all 16
runtimes PASS. OpenCode 2.2.5 18/18, Codex 0.166.0 23/23, Claude Code 2.1.316 21/21, Gemini 1.4.12 15/15, Autohand 0.9.9
16/16, Qwen 0.26.6 19/19, Kimi 2.4.1 23/23, Grok 1.0.70 22/22, DeepSeek 2.56.0 21/21, Cursor 2026.10.22-27dcf5f 23/23,
Copilot 1.0.105 24/24, Hermes 0.22.5 16/16, OMP 18.14.2 14/14, Qoder 1.1.81 16/16, Muse 1.4.14 15/15, Droid 0.244.0 12/12.
The run before the fix (`20261103T161534Z-inventory.json`, `541946e42d`) gave 15 PASS and Cursor PASS_WITH_UNVERIFIED.
Copilot and Hermes, FAIL on 2026-10-29 02:46, pass since that day's fixes (see below).

Cursor's unverified check was the canary's own probe, not Cursor: the acceptance probe ran the flag with `--help`, and
commander (in `cursor-agent`) answers `--help` and `--version` before it rejects unknown options, so the control
`--space-canary-unknown-flag --help` exited 0. With `status`, the wrapper's own `--disable-auto-update status`, the same
binary rejects the unknown flag (exit 1, "unknown option") and accepts `--disable-auto-update` (exit 0, "Not logged in"
offline). Cursor's expectation now probes with `acceptWith: ["status"]`; the check can fail again if Cursor drops the flag
(`scripts/tests/cli-canary.test.mjs`, the Cursor case, UNVERIFIED without the change).

## Canary inventory, 2026-10-29

`node scripts/cli-canary.mjs --inventory` from repository commit `60b31c0d98`
(`/var/lib/spaceapp-user/agent-workspace/reports/cli-canary/20261029T024652Z-inventory.json`): the binary each wrapper runs today,
probed with `--version` and `--help` only, in a private network namespace with an empty HOME; nothing promoted, no session
started, no provider request. 13 PASS, Cursor PASS_WITH_UNVERIFIED as on 2026-10-11, Copilot and Hermes FAIL.

| Runtime | Version reported | Verdict | Checks passed | Note |
| --- | --- | --- | --- | --- |
| OpenCode | 2.1.2 | PASS | 18/18 |  |
| Codex | 0.165.0 | PASS | 23/23 |  |
| Claude Code | 2.1.307 | PASS | 21/21 |  |
| Gemini (Antigravity `agy`) | 1.4.4 | PASS | 15/15 |  |
| Autohand | 0.9.8 | PASS | 12/12 |  |
| Qwen Code | 0.26.1 | PASS | 19/19 |  |
| Kimi Code | 2.3.0 | PASS | 21/21 |  |
| Grok Build | 1.0.67 | PASS | 21/21 |  |
| DeepSeek (Reasonix) | 2.47.1 | PASS | 21/21 |  |
| Cursor | 2026.10.22-27dcf5f | PASS_WITH_UNVERIFIED | 21/22 | `--disable-auto-update` unverifiable by the parser probe (known, checked in its bundle 2026-10-16) |
| GitHub Copilot | 1.0.105 | FAIL | 22/24 | `--no-remote` and `--no-remote-export` not in `--help`; see below |
| Hermes Agent | 1.0.0 | FAIL | 7/14 | 7 flags not found; `--help` in an empty HOME prints only "no dependency environment is committed for this install; run `hermes pm repair`", so nothing was probed |
| OMP | 18.12.1 | PASS | 12/12 |  |
| Qoder | 1.1.58 | PASS | 16/16 |  |
| Muse Code | 1.4.13 | PASS | 13/13 |  |
| Droid | 0.244.0 | PASS | 12/12 |  |

- **Copilot 1.0.105 removed `--no-remote`.** The wrapper passes it on every launch (`deploy/copilot-vscode-parity`),
  and the binary now stops with `error: --no-remote was removed. Use /remote off in a session; manage incoming
  connections in /environments.` (checked in the same isolation). `--no-remote-export` is still accepted but hidden.
  1.0.105 became `current` on 2026-10-28 at 00:57 UTC, a root-owned install like 1.0.103 (10-23) and 1.0.104
  (10-27) before it; `scripts/cli-maintenance-updater.mjs` runs none of the canary's flag checks before it switches
  `current`. 1.0.103 and 1.0.104 are still on disk. Until the wrapper or the version changes, a Copilot pane cannot
  start.
- **Hermes could not be probed in isolation.** Its `--help` needs the dependency environment of its data root,
  which an empty HOME does not have, so its seven flag checks found nothing. The "1.0.0" above is a package manifest the
  canary fell back to because the CLI printed no version; the installed Hermes is 0.22.4 (`install-stamp.json`).

**Rerun at 04:23 UTC** (`20261029T042340Z-inventory.json`, ADAPTER-001 slice A): Hermes 0.22.4 `PASS` 14/14 and Copilot 1.0.105
`PASS` 23/23 (its wrapper no longer passes `--no-remote`); every other runtime as above. Hermes's probes now run in a private
mount namespace as well, where its data root (`~/.hermes`, found from the binary's path) is a copy-on-write overlay and
`HERMES_HOME` points at it: Hermes boots from its committed environment and takes its install lock in the overlay, and the
real data root is never written (checked: no file under `~/.hermes` changed). A Hermes binary outside a `.hermes` folder
is `BLOCKED: DATA_ROOT_UNKNOWN`, an overlay that cannot be mounted `BLOCKED: ISOLATION_UNAVAILABLE`, and a Hermes that still
asks for `hermes pm repair` `BLOCKED: DATA_ROOT_UNUSABLE`; none of them passes a check. Tests: the Hermes cases of
`scripts/tests/cli-canary.test.mjs` (a fake Hermes that needs a committed environment and a writable lock).

**Composer markers, 2026-10-29** (ADAPTER-001 slice B, screens in `agent-workspace/reports/20261029-adapter-001-markers`): idle
screens captured in tmux from the installed binaries, started as their wrappers start them, nothing typed. Copilot 1.0.105 draws
`← open sidebar · Interactive · Allow All · / commands · ? help · tab next tab` under its composer and Reasonix 2.47.1 (DeepSeek)
`YOLO  · ready · Shift+Tab read-only/ask/auto/YOLO/plan · Ctrl+Y YOLO`; `/ commands · ? help` and `· ready · shift+tab` each appear
once and are their markers now. Autohand (account and OpenRouter key setup), Kimi (Kimi Code OAuth) and Muse 1.4.13 (login
chooser on screen) start on a login or setup step on this host and keep the startup timeout until they are signed in. 2026-11-03:
Muse 1.4.14 on its `echo` provider, which needs no sign-in (throwaway HOME, `--yolo` as its wrapper runs it, nothing typed;
`agent-workspace/reports/20261103-adapter-001-muse`), draws `❯` between two rules and the footer `echo · <directory> · YOLO`
("YOLO always stays visible" in its binary); `· yolo` is its marker, and its login chooser has none. Kimi Code 2.4.1 now starts
on this host's Kimi home (tmux, `--yolo` as its wrapper runs it, nothing typed; `agent-workspace/active/20261103-adapter001-kimi`):
its composer box row `│ >` is its marker, and its folder-trust menu has none; with `--session` and no id it draws the composer,
then the session picker over it, so a composer row must follow the picker's `Esc cancel` hint (a session picked). Open
blocker: Reasonix holds 5 `space_dispatcher` tools out of the model's tools until `reasonix mcp trust space_dispatcher` is run
(not run: the trust step is not an agent's to take).

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
  the live re-proof waits for the promote. Passed on dev 2026-11-03 (below).
- **Gemini, 2026-11-02 (EXT-G-6):** start, send, interrupt and `/quit` passed through Space Control on dev
  (C, `space-gateway` profile, Antigravity CLI 1.4.12). The recorded conversation id equals the one agy prints
  on exit. Evidence: `~/agent-workspace/reports/20261102-ext-g-6-gemini/summary.json`.
  - Second run after the stable promote (`summary-2.json` in the same folder): exact resume by conversation id passed
    through `space-admin-action control` `resume` (C) once a Gemini task resumed on its own account and recorded its
    conversation as the task reference (both on dev). On dev Space Control's own confirmation answers UNKNOWN (no process
    tree, read-only `/opt/spaceapp`); the resumed agy answered from the original conversation.
  - Browser reattach: `PROVE_CLI_INPUT` first failed "did not start on the selected Gemini account profile" (it picked a
    direct account; new panes start on `space-gateway`). With the proof selecting the ready Space Gateway profile it
    passed on stable after promote `q-20261102-003539-dace` (I): after the page reload the terminal reattached to the same
    session, pid and generation, and the transcript kept the input and the answer (`cli-input-stable-1.json`).
  - The direct account with no Gemini quota figures (`main`) does not serve a turn ("Individual quota reached"); Space
    showed the pane IDLE with no usage limit, and now reads the message as a usage limit (dev, `agents-dashboard.test.ts`). ADAPTER-010: an account switch deletes the pane's conversation file first.
  - Space Control's `start` after an exit reported UNKNOWN ("not confirmed after resume") for a new session;
    fixed on dev (the EXT-G-6 case in `apps/api/tests/space-control.test.ts`).
- **Gemini on dev, 2026-11-02 (ADAPTER-001):** `PROVE_CLI_INPUT` (I) passed on dev (6dab636c67, Antigravity on the
  `space-gateway` profile): a new single-pane proof room, a draft with an edit and a paste submitted from the browser, and the
  model's exact uppercase answer on the screen; session, pid and generation the same across a 15 s dwell and a page reload;
  room deleted afterwards. Report `~/agent-workspace/reports/20261102T162836Z-space-auth-proof-929ceb4f-3057-420f-9a47-135362ed7cbd`.
  The same proof for Copilot, Grok, Cursor, Qwen and Autohand stops before a pane opens: dev's `/api/cli/runtimes` does not list
  them (off in the runtime settings; they also need a sign-in only the operator can do).
- **Codex and Claude Code, 2026-11-03 (EXT-G-6):** through `space-admin-action control` (C) in owned Agent Proof rooms,
  deleted afterwards; evidence `~/agent-workspace/reports/20261103-ext-g-6-interrupt-resume/summary.json`.
  - Codex interrupt (dev, 0.166.0): a stop during a `sleep 150` tool call answered interrupted, the screen showed
    "Conversation interrupted", the next prompt was answered in the same session and thread, no late reply. Codex keeps the
    command in its own background terminal (`/ps`), which is Codex's design; the turn ended.
  - Claude Code interrupt (dev, 2.1.316, `space-gateway`): Claude Code moves a bare 150 s `sleep` to the background itself, so
    the stop hit a foreground loop of 1 s sleeps: "Interrupted", and the next prompt recalled the first turn's word in the same session.
  - Codex exact resume by thread (dev): a second pane made a newer thread in the same folder; resume answered `NATIVE_RESUME`
    with Space's thread check passing, and the pane answered its own thread's token, not the newer one's. The process was live,
    so the thread resumed in place; a resume after host loss is not shown.
  - Claude Code exact resume by session (stable): with a newer conversation in the same folder from a second pane, resume
    started a new process (`NATIVE_RESUME`, same recorded native session) that answered the resumed conversation's word.
    Dev cannot show it: its API (no sudo, private PID namespace) never runs the launcher's `native-turns` reader, so dev
    records no Claude `nativeTaskRef`.
- **Hermes, OMP, Qoder, Droid, Muse, Kimi, DeepSeek and Qwen, 2026-11-03 (plan `clipboard:NtzEOzE3Ew00` step 9):** through
  `space-admin-action control` (C) on dev, in one owned Agent Proof room (deleted afterwards). Each runtime got a nonce prompt, then a
  stop during a 150 s shell loop, then a second nonce. Runtimes switched on for the test were switched off again. Load was about 50
  on 24 cores. Evidence: `~/agent-workspace/reports/20261103-plan-NtzEOzE3Ew00-step9-runtime-lp/summary.json`.
  - Hermes 0.22.5: start, send and interrupt passed, the interrupt twice. Each stop ended the turn: Hermes' log has "Command
    interrupted" and "Turn ended: reason=interrupted_by_user". The next nonce was answered in the same session. While a command
    runs, the screen shows only "computing…"; Hermes' own log is the evidence.
  - OMP 18.14.2: start and send passed; the interrupt **failed**. When OMP runs the shell command in a terminal of its own
    (`pty:true`), Space's stop (Escape) aborts only that command. Space answered interrupted and the pane read IDLE, but the model
    ran the command again and the turn went on. The next Space prompt was typed into the running command and never answered.
    A stop while the command ran without its own terminal ended the turn, and the next nonce was answered in the same session.
    Fixed the same day: an OMP stop now sends Escape, then follow-up Escapes at +1.5 s and +3 s (5bd8cbc5eb,
    `room-pane-cli-controller.ts`). OMP's command overlay takes every key while it runs, and its Escape kills only the command; a
    later Escape stops the turn. At an idle composer a single Escape only records the time (two within 500 ms open its rewind
    selector). Re-proof on dev 53060b4751: the model ran the loop with `pty: true` and was stopped through Space Control. The command
    ended ("Command aborted", +1.6 s), the turn ended (`aborted`, +3.1 s) with no re-run, and the next nonce was answered in the same
    session (`~/agent-workspace/reports/20261104-plan-NtzEOzE3Ew00-omp-reproof/summary.json`). The pane's own Stop button in the browser
    still sends one Escape (Warm-protected files, not changed).
  - Qoder 1.1.81: start passed. Send could not run: its model is served by the Claude API key, which was over the day's budget share.
    Re-run after the budget reset (dev 2026-11-04 00:28 UTC, Qoder 1.1.82, its own owned room, deleted afterwards): send, interrupt
    and the next nonce passed. A stop during the foreground loop ended the turn 2.3 s later (Qoder's session file records
    "[Request interrupted by user for tool use]"; the screen showed "User cancelled."). The loop's process was gone, the command
    did not run again, and the next nonce was answered in the same native session
    (`~/agent-workspace/reports/20261104-plan-NtzEOzE3Ew00-qoder-lp/summary.json`).
  - Droid 0.244.0 and Muse 1.4.14: the process starts, then asks for a sign-in (a Factory login; a browser login or an API key).
  - Kimi, DeepSeek and Qwen: no pane opens, because the runtime needs a sign-in or setup first (LOGIN_REQUIRED or SETUP_REQUIRED).
- **Not proven:** `ADD_CLAUDE_CODE_CLI` and `ADD_GEMINI_CLI` (the proof
  room was not created or did not become ready, twice); host-loss resume for every runtime. Runtimes that need the operator's
  sign-in first: Droid, Muse, Kimi, DeepSeek, Qwen, Grok, Cursor, Copilot and Autohand.
- **2026-11-04 (plan clipboard:NtzEOzE3Ew00 step 9, P8; `~/agent-workspace/reports/20261104-plan-NtzEOzE3Ew00-step9-p8/summary.json`):**
  - Hermes exact resume, stable Agent Proof room: pane B's session was the folder's newest. Space's resume of pane A answered
    NATIVE_RESUME and launched `hermes --tui --resume local-1d2cc6cb…` (A's), and the pane showed A's prompt.
  - OpenCode exact resume, stable: resume replaced the running session with `--session ses_e5ae…`, whose transcript showed the
    pane's word. Agents may not call `restart`, so the CLI was replaced in place, not after an exit.
  - Hermes 0.22.5 and OMP 18.16.0 on dev, where no native reference is recorded: Space's resume started a fresh session, typed
    `/resume` and failed "The requested menu selection could not be verified" (ADAPTER-013).
  - A Hermes gateway started by a dev pane blocked stable's Hermes panes (ADAPTER-012).
  - Qoder could not run a turn: the plan's usage limit was reached. OMP is off on stable.

| Runtime | start | send | interrupt | native resume | reconnect |
| --- | --- | --- | --- | --- | --- |
| OpenCode | CT SA UF; LP pass (C) | CT; LP pass (C), browser-typed LP fail (see below) | CT; LP pass (C) | REFERENCE + provider selection: CT SA UF; exact session resume LP pass (C, stable 2026-11-04, the running session replaced) | live host CT; host loss resumes (CT); LP U |
| Codex | CT SA UF (resolved model required); LP pass (I) | CT; LP pass (I) | CT; LP pass (C, dev 2026-11-03; failed 2026-10-16 before its fix) | REFERENCE (thread): CT SA UF; resume picker LP pass (R); exact thread resume LP pass (C, dev 2026-11-03, live process) | live host CT; host loss resumes once a thread is bound; browser reattach LP pass (I) |
| Claude Code | CT SA UF; LP pass (I) | CT; LP pass (I) | CT; LP pass (C, dev 2026-11-03) | REFERENCE + picker fallback: CT SA UF; exact session resume LP pass (C, stable 2026-11-03) | live host CT; host loss resumes; browser reattach LP pass (I) |
| Gemini | CT SA UF; LP pass (C), (I stable and dev 2026-11-02) | CT; LP pass (C), (I stable and dev 2026-11-02) | CT; LP pass (C) | REFERENCE (conversation id, `agy --conversation <id>` from the wrapper) + provider selection: CT SA (env_keep) UF; wrapper live check 2026-10-30 (see below); id recorded = id agy prints on exit, LP pass (C); resume by id LP pass (C, dev 2026-11-02, after the account and reference fixes) | live host CT; host loss resumes; browser reattach LP pass (I, stable 2026-11-02) |
| Autohand | CT SA UF; LP U | CT; LP U | CT; LP U | exact reference source integration; component proof only, LP U | native picker without a reference; later native resume errors may start fresh |
| Qwen | CT SA UF; LP U | CT; LP U | CT; LP U | REFERENCE (the session the TUI's own `chats/<id>.runtime.json` names, `--resume <uuid>`) + `--continue` fallback: CT SA UF; LP tmux 2026-11-03 (0.26.1) | live host CT; host loss resumes; LP U |
| Kimi | CT SA UF; LP U | CT; LP U | CT; LP U | REFERENCE (the session the pane's process leased for a turn, `--session <id>`) + picker fallback: CT SA UF; LP tmux 2026-11-03 (2.4.1) | live host CT; host loss resumes; LP U |
| Grok | CT SA UF; LP U | CT; LP U | CT; LP U | REFERENCE (`SPACE_GROK_SESSION_ID`: fresh `--session-id <uuid>`, stored `--resume <uuid>` from the wrapper): CT SA UF; LP wrapper inner mode 2026-11-02 (1.0.70) | live host CT; host loss resumes; LP U |
| DeepSeek | CT SA UF; LP U | CT; LP U | CT; LP U | REFERENCE (task history): CT SA UF; LP U | live host CT; host loss restarts fresh (declared) |
| Cursor | CT SA UF (`--disable-auto-update`: upstream source, see below); LP U | CT; LP U | CT; LP U | REFERENCE (`SPACE_CURSOR_SESSION_ID`: `--resume <uuid>` fresh and once stored, from the wrapper): CT SA UF; LP wrapper inner mode 2026-11-02 (2026.10.22) | live host CT; host loss resumes; LP U |
| Copilot | CT SA UF; LP U | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| Hermes | CT SA UF; LP pass (C, dev 2026-11-03, 0.22.5) | CT; LP pass (C, dev 2026-11-03) | CT; LP pass (C, dev 2026-11-03, twice) | REFERENCE (the session its TUI's client env names, `--resume local-<sha256>`) + `--continue` fallback: CT SA UF; exact session resume LP pass (C, stable 2026-11-04, 0.22.6 gateway); without a recorded reference LP fail (C, dev 2026-11-04, ADAPTER-013) | live host CT; host loss resumes; LP U |
| OMP | CT SA UF; LP pass (C, dev 2026-11-03, 18.14.2) | CT; LP pass (C, dev 2026-11-03) | CT; LP pass (C, dev 2026-11-03, after the fix 5bd8cbc5eb; the first run failed during a `pty:true` command, see below) | REFERENCE (the breadcrumb's session, `--resume <id>`) + `--continue` fallback: CT SA UF; LP tmux 2026-11-02 (18.14.2); without a recorded reference LP fail (C, dev 2026-11-04, 18.16.0, ADAPTER-013); exact LP U (off on stable) | live host CT; host loss resumes; LP U |
| Qoder | CT SA UF; LP pass (C, dev 2026-11-03, 1.1.81; 2026-11-04, 1.1.82) | CT; LP pass (C, dev 2026-11-04) | CT; LP pass (C, dev 2026-11-04) | REFERENCE (`-r <uuid>`, fresh `--session-id <uuid>`): CT SA UF; LP wrapper inner mode 2026-11-02; Space LP blocked 2026-11-04 (the plan's usage limit) | live host CT; host loss resumes; LP U |
| Muse | CT SA UF; LP U (dev 2026-11-03: the process starts, then asks for a browser login or an API key) | CT; LP U | CT; LP U | provider selection: CT SA UF; LP U | live host CT; host loss resumes; LP U |
| Droid | CT SA UF; LP U (dev 2026-11-03: the process starts, then asks for a Factory login) | CT; LP U | CT; LP U | exact reference source integration; native capture and LP U (2026-11-04) | live host CT; host loss resumes; LP U |

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
  `--disable-auto-update` is checked with `status` since 2026-11-03 (its parser lets
  `--help` win over an unknown flag, so a `--help` probe proved nothing; see Canary
  inventory, 2026-11-03). Checked in the shipped bundle before that (2026-10-16, `2026.10.14-941492e`):
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
- **Gemini resumes by conversation id (2026-10-30, ADAPTER-006).** On RESUME the
  wrapper turns `--continue` into `agy --conversation <id>` when the pane's own
  conversation (`SPACE_GEMINI_CONVERSATION_ID`, or the pane or tty file) is in the
  active account's store; otherwise it keeps the `--continue` it steers. Gemini
  declares `REFERENCE`, so 5 of 16 runtimes do: Codex, Claude, OpenCode, DeepSeek
  and Gemini. Ten reach only a provider selection (Qwen and Qoder of them pass a
  recorded reference pending a live proof) and Autohand has no native resume.
  Evidence: a live check through the wrapper's inner mode on public-host, not a Space
  Agent Proof room (conversation A resumed by id while a newer conversation B was
  the workspace's latest), and `scripts/tests/gemini-qwen-runtimes.test.mjs`.
- **Qoder resumes by session id (2026-11-02, ADAPTER-006).** Its launcher already
  passed the pane's Space-named session (`--session-id <uuid>` fresh, `-r <uuid>` on
  RESUME); a live check through the wrapper's inner mode (qodercli 1.1.81) resumed
  session A by id while a newer session B was the folder's latest, so Qoder declares
  `REFERENCE`: 7 of 16 runtimes do. Qwen alone still withholds it pending a live proof
  (its Coding Plan quota was exhausted on 2026-11-02).
- **Hermes resumes by session id (2026-11-03, ADAPTER-006).** The task titles bind the pane's session through
  the Space session its TUI's client env carries into the session's stored policy (Hermes 0.22.5 runs every TUI
  session in one shared gateway, so no lease names the pane). RESUME passes `--resume <id>`, or `--continue` when
  none is recorded or the store lacks it. Hermes declares `REFERENCE`: 12 of 16 runtimes did then.
- **Kimi resumes by session id (2026-11-03, ADAPTER-006).** The task titles record the session whose turn lease
  (`locks/sessions/<id>.lock`) a process of the pane holds. RESUME passes `--session <id>`, or opens the `--session`
  picker when none is recorded or the store lacks it. Kimi declares `REFERENCE`: 13 of 16 runtimes did then.
- **Qwen resumes by session id (2026-11-03, ADAPTER-006).** Qwen 0.26.1's TUI takes no writer lease (only its
  managed-session server does), so the task-title bridge never bound a pane; it now reads the TUI's own
  `chats/<id>.runtime.json` (pid, host, written after the process started). RESUME passes `--resume <uuid>`, or
  `--continue` when none is recorded or the store lacks it. Qwen declares `REFERENCE`: 14 of 16 runtimes do. Droid still
  reaches a provider selection (no Factory login on public-host).

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

### Autohand composer readiness, 2026-11-03 (ADAPTER-001)

Autohand `0.9.9-space.1` now has a source readiness marker: its installed native
`readInstruction` component draws `❯ Plan, search, build anything`. An isolated
PTY invoked that exported component through the same argument interface used by
`PromptInstructionReader`, with empty fixture files/status/suggestions, at 100
and 42 columns. Both runs accepted `fixture-ready` and returned it to the harness.
The component was unmodified; no provider request or authentication was used.

A separate normal CLI startup, using an isolated `AUTOHAND_HOME`/config, stopped
at the native login menu (`Sign in to continue.`, followed by `↑↓ Navigate · ↵
Select · 1-9 Shortcut · ESC Cancel`). Updates, ping and auto-report were disabled
with the CLI's supported settings and `--no-daemon` was used. The readiness check
rejects a menu footer newer than the composer marker, including an old composer
retained in output, until a new composer is drawn. The no-marker classification
list is now empty.

This is executable native **component** evidence plus a real login negative,
not a signed-in whole-CLI start/send/reattach/resume proof. Account activation
and the existing guarded host-loss proofs remain pending. No auth bypass, real
profile read, runtime enablement, host operation or Warm change was performed.
Captures and harness: `agent-workspace/reports/20261103-adapter001-autohand-readiness/`.
