# AI review remediation evidence

This directory tracks implementation of operator PLAN `clipboard:wxc6q7AaaMt6`.
It is an evidence index, not a claim of a 5/5 rating or completed roadmap.

`baseline.json` pins the inspected source, local public checkout, public export
source and launcher version separately. The runtime image digest and public CI
run are unknown until an exact release candidate is built and tested. Do not
substitute the private source SHA for a public Git SHA.

`review-findings.json` gives each substantive observation a stable ID, source,
disposition, owner, affected code, reproduction/evidence pointer and a
`resolution` (fixed, partial, open, accepted-tradeoff, product-decision,
not-a-defect). `KNOWN_LIMITATIONS.md` is generated from it. The early
observations are the supplied roadmap's synthesis, not verbatim review quotes;
the complete Kimi attachment remains unavailable. Claude reviews exist since
2026-10-12, and the 2026-10-14 reviews of the v1.1.4 snapshot are recorded as
`EXT-C-*` and `EXT-G-*` (see `verification-results.json`).

## Implemented security slice

- Workspace-mode read, raw stream, listing and search use pinned Linux file
  descriptors, no-follow traversal and validation of the opened object. They do
  not check a pathname and then reopen that pathname for content. Special files
  and symlinks are rejected. Unsupported platforms fail closed. The configured
  root is trusted; this does not sandbox an operator with host privileges.
- Artifact deletion and expired-browser-file cleanup also use a pinned parent
  descriptor; they cannot follow a replaced ancestor into another directory.
  Missing-file deletion retains its existing idempotent behavior.
- User-mode writes, creates, uploads, renames and deletes remain forbidden.
  Explicit ADMIN/OPERATOR host mode remains available.
- Raw files and artifact downloads use `nosniff`, private/no-store caching and
  a sandbox CSP. Active/unknown formats are attachments; sanitized DOCX preview
  keeps its existing sandbox. Text previews remain plain text. Artifact reads
  share the containment implementation.
- Filesystem multipart uploads stream to exclusive, random temporary files;
  enforce 100 MiB/file, 250 MiB/request, ten files and four active requests; and
  publish only after parsing succeeds. Truncation/error/abort removes partials.
  A request containing several files is not a multi-file atomic transaction:
  an I/O failure during the final sequence of renames can leave earlier complete
  files committed. It never reports successful completion in that case.
- File search distinguishes no matches from missing tool, permissions, timeout
  and other failures. Workspace search has a five-second/10,000-entry scan budget,
  excludes hidden entries, `.git` and `node_modules`, and supports filename globs.
  It does not read `.gitignore`; host-mode search retains ripgrep behavior.

Agent Files publishing and room uploads also stream through private staging,
with the same process-wide concurrency bound and byte budgets. File size and SHA
are checked before artifact metadata is created; symlinked storage ancestors are
rejected before directory creation. DOCX normalization retains its bounded buffer
interface. All multipart routes in `app.ts` now use that shared admission/staging layer.
Bookmark JSON (2 MiB) and voice provider input (10 MiB) materialize only their
bounded input while retaining the admission slot. Ordinary attachments persist
by streamed copy/hash validation through pinned no-follow ancestors. Parsing and
validation finish before any artifact in a batch is recorded. A later storage/DB
failure can leave earlier complete artifacts: multi-file atomicity is not claimed.
The 96 MiB staging regression keeps observed RSS growth below 64 MiB, including
the post-stream sample. The separate `files-upload-http.test.ts` uses the real app and login/CSRF over
localhost HTTP: four 64 MiB streams, fifth-request 429, interrupted-request
cleanup and slot reuse, exact stored hashes, and 100 MiB+1 rejection preserving
the existing file. Combined client/server RSS growth stays below 128 MiB for
256 MiB of completed bodies without forced GC. All 24 upload/security checks
pass at `0baa613b7f`. This is not a production browser/proxy-load benchmark.
Authenticated browser proofs and deployment remain separate acceptance work.
Privileged host processes can still change already-open files or relocate trees.

## Reproduction

Use Node as declared in the root `engines` field. Build workspace dependencies
from this same checkout before API tests. Use a short, owned TMPDIR for Unix
socket tests; long agent-home paths exceed the operating system socket limit.

```sh
npm test -w @space/api -- src/__tests__/files.test.ts src/__tests__/files-containment.test.ts src/__tests__/files-search-errors.test.ts tests/files-routes-security.test.ts tests/file-upload.test.ts tests/agent-files.test.ts --testTimeout=30000
npm run check -w @space/api
npm test -w @space/cli-host -- tests/ipc.test.ts tests/session-registry.test.ts
npm test -w @space/browser-host -- tests/ipc.test.ts
npm test -w @space/runtime -- tests/memory-mutation-executor.test.ts
npm test -w @space/db -- tests/migration-runner.test.ts
```

The API authentication fixtures select the session cookie by name, not response
order: login also clears a logout cookie. A prior fixture used that cleared
cookie and produced 401s without testing the intended authenticated behavior.
The lockfile now includes the existing desktop/mobile workspaces; isolated
`npm ci` succeeds with Electron binary download skipped for API-only tests.
No client artifact or installer acceptance is implied.

## Gates still open

The ten-package roadmap remains in progress. In particular, no 60% decomposition,
complete adapter compatibility matrix, complete tracing/budget registry, full application restore,
multiplatform installer acceptance, public CI run, or fresh independent rating is
claimed. Existing local unit/integration tests are distinct from real native CLI
proofs. See `failure-matrix.md`, `runtime-compatibility.md` and `state-ownership.md`.
The protected six-room/96-pane performance baseline is unchanged; no new large
workspace warm-retention result is claimed.

## Migration identity and retry validation

The loader preserves complete historical IDs and applies migrations in
deterministic full-filename order. Since 2026-10-11 the identity rules (stable
filename format, no new numeric-prefix collision) are enforced by
`migration-identities.test.ts` against the real migration set rather than at
deploy time, after a live deploy rolled back because two concurrent sessions
had both shipped `0148`. Only the already-shipped files sharing 0034, 0088,
0089, 0148, 0154 and 0157 are exempt (six pairs, 12 files; 0154 and 0157 collided when two
sessions shipped migrations concurrently on 2026-10-11 and 2026-10-12). Since 2026-10-12 the same
check also runs in the merge queue's `test:deploy` (`scripts/tests/migration-identity-gate.test.mjs`),
so a colliding ticket fails in the isolated build and is renumbered before it ships. Invalid retry budgets now reject before
executing SQL; previously a zero/NaN budget could silently skip the migration.
The ambiguous-COMMIT regression proves that a connection error does not cause an
automatic repeat. These tests are not a clean-install/upgrade/restore proof.
Separately, 25 real PostgreSQL checks applied the complete migration history to
fresh databases, and a synthetic dump/restore verified table hashes and foreign
keys. [postgres-proofs.md](postgres-proofs.md) records the scope and exclusions.

## Additional verified findings

Auto-login was assigning the preinstalled operator/owner to unauthenticated
remote requests. The effective client address must now be loopback before either
auto-login path runs. Signed remote sessions, local operator behavior and explicit
logout are preserved. A reverse proxy must correctly propagate the client IP;
never expose a localhost-trusting endpoint through a proxy that masks every client
as loopback. Tests include trusted-proxy forwarding and spoofed headers from an
untrusted peer. No live exposure or exploitation investigation was performed.

Unknown HTTP paths no longer become metric labels. They aggregate as `unmatched`,
which bounds cardinality and prevents raw private paths from entering metrics.
Registered route templates, request totals and status classes remain available.

`verification-results.json` holds the current status under `current` (live SHA, completion estimate, deploy path, independent reviews, open gates) and the 2026-10-03 pause checkpoint under `history`, which records passing scoped checks and broad-suite failures
separately. Full CI is not green. The frontend observer-control guard was
explicitly approved and committed as `aa61f205a0`; five scoped checks and web
typecheck pass. Real browser/performance acceptance remains pending.
Independent reviews since then are listed under
`current.independentReview` in `verification-results.json`.

## Ambiguous artifact acknowledgements

Complete upload bytes are no longer deleted after an uncertain database reply.
Private intent journals support bounded, read-only reconciliation without repeating
the write. See [upload-reconciliation.md](upload-reconciliation.md). This covers
multipart uploads, Agent Files and JSON Control publishing; partial-file cleanup
before recording is preserved. JSON Control storage now also rejects symlinked
ancestors and participates in the shared four-upload admission limit.

The worker suite now passes 155 tests after repairing durable fixture setup and
distinguishing missing execution state from CLI startup failure. A descriptor
default is a configured fallback, not a discovered provider capability. Broad
frontend and API results and the remaining real-runtime gates are recorded
separately; no end-to-end completion claim follows from these unit results.

## Initial artifact domain extraction

`artifact-read-routes.ts` registers artifact listing, file streaming, downloads
and previews with a narrow `listArtifacts/getArtifact` store interface.
`artifact-storage.ts` owns storage URI mapping, names, contained deletion and
retention cleanup. `http-errors.ts` preserves the shared HTTP error envelope.
The composition root retains authentication, rate limits, request IDs, timers
and upload/creation orchestration. No new module imports the application root.

Commit `6c68110cff` removes 247 lines from `app.ts`. Three route tests run with a
standalone Fastify instance; 32 domain/containment/Agent Files checks pass together.
This is an initial extraction, not achievement of the 60% API/frontend target.

## Current implementation evidence

The current 38% estimate is an engineering assessment across the ten acceptance
packages, never a test pass rate. Exact current counts, snapshot IDs and
outstanding checks are in `verification-results.json`.

The three specifically approved readiness/control changes are committed:
stale Codex startup-marker handling, unsolicited control-upgrade rejection,
and the HTTP replacement lease check. The latter rechecks ownership immediately
before interruption and preserves read-only rejoin. Protocol-v2 controls passed
11 checks and the full TerminalPane suite passed 201 before subsequent unrelated
shell changes. These do not certify live provider continuity or deployment.

All five API CLI files passed **194/194** at `f349ce6d99`. Their fixtures retain
real PTYs, process IDs, generation, output and ten-second continuity limits;
unrelated analytics ingestion is replaced with owned empty inputs. The earlier
192-pass/two-timeout result is historical. Full worker checks passed 165 and
contracts passed 228. Later scoped results remain separate from broad runs.

Implementation also covers byte-exact history rollback, bounded catalog reads,
server-owned request IDs with URL redaction, login capability admission,
pending-until-acknowledged Control delivery, cancellation before CLI spawn,
byte-bounded worker output and truthful native model settings. History purge
errors now keep helper diagnostics private. Closed panes retain the real exit
cause in both stores; real PostgreSQL and authenticated route fixtures cover it.
See [context-and-budgets.md](context-and-budgets.md) for unresolved tracing,
usage accounting, upstream compatibility and native continuation work.

## Configuration security and frontend reliability

Ordinary authenticated users could export secrets or import installation
configuration. Both paths now reject them before secret collection or mutation;
ordinary own-data export remains available. Four standalone domain checks plus
ten authorization and two migration checks pass. The UI passes the explicit
ADMIN/OPERATOR capability, uses the selected runtime API/reload gateway, and the
demo returns `DEMO_UNSUPPORTED` for migration. No real secrets were collected or
installation files imported by the fixtures. This is not a full tenancy audit.

Account image-preview preferences no longer write before authentication or echo
stale defaults during hydration. Explicit user changes still persist. Voice and
agent settings now have independent components with characterization tests run
before and after extraction; lazy cards preserve visited drafts and capability
checks. The API availability state has no UI import and preserves existing
recovery timing and subscription semantics.

The frontend API-client tests exhausted their worker heap by reinstantiating the
large immutable contracts/Zod graph after each module reset. They now share the
real schemas while continuing to reset mutable client caches. All 31 client and
11 availability checks complete in the scoped run; observed per-case heap stays
about 135–155 MiB instead of reaching about 2 GiB. Full-run outcome is recorded
separately. No fake schemas or higher heap limit hide the failure.

## Domain and contributor boundaries

API artifact, private data, MCP, streaming and configuration routes have narrow
dependencies and standalone tests. Voice, settings, authentication and API
availability have frontend domains. The dependency ratchet rejects new cycles
and domain back-imports into composition roots. Removing 47 unreachable local UI
functions produced identical SHA256 hashes for all 158 generated build files.
On dev `860ae01ced` (2026-10-12) the roots are 7,593 API lines and 7,238 frontend lines: reductions of 61.0% and 60.2% from baseline, so the 60% target is met for both ([decomposition-proposal.md](decomposition-proposal.md)). Main keeps adding code to both roots; the dependency ratchet keeps new domains out of them.

[The contributor guide](../../CONTRIBUTING.md) provides `npm run smoke:offline`.
It executes two synthetic arithmetic tasks through the real PTY/Unix IPC host,
checks results and reconnect identity, rejects duplicate input, and removes its
owned process/socket/directory. Three checks cover success, wrong output and
early exit. This is simulation, not provider compatibility evidence. The API
configuration registry describes 137 fields with defaults from the canonical
parser, private diagnostics and an advisory preflight. Other service registries
and dedicated Linux/Windows/macOS installer acceptance remain open.

## Integration requirement

The operator requires the final candidate to include **all SpaceApp changes
made since this task began**, including concurrent work. Refresh from the
then-current canonical `main`, preserve unrelated commits and working edits,
resolve conflicts, test the combined result, and repeat the freshness check
immediately before deployment. This isolated task checkout must never replace
newer live work.

**Status on 2026-10-12.** The remediation work is integrated and deployed through
the merge queue: every batch deploys to dev first, and the operator promoted dev
to stable at 12:06Z (`5943acb475`). Final independent reviews ran on dev
`bc484aa8c6` (see `verification-results.json`). Public CI is checked on the
published 1.1.3 SHA. The paragraphs below, up to the next heading, are dated
history: each describes the SHA it names, not the current tree.

The latest complete frontend run at `bc46e4d6f4` has **2,430 passed and 45
failed out of 2,475 tests**, with no pending tests and unchanged frontend files
throughout the run. The complete API run at `00d7ad3777` passed **2,170 checks
with eight skips and zero failures**, across 214 passing files and one skipped
file, in 1,386.44s. API source/tests stayed unchanged while frontend work continued.
Temporary phase timings had traced roughly four to five seconds of route-fixture
teardown to unrelated analytics collection. Owned analytics inputs reduced both
complete files from 43.68s to 11.78s (13 passed) without changing deadlines before
the successful full run. Historical failures remain in the verification index.

Four concurrent integrations include canonical `f20b4f39aa`, `ea5f14dbe4`,
`09deef863a`, and `30546b2668`; the latest merge is `20df7cd389`. Its selected
repository comparison passed 29 API, eight UI and five proof-script checks,
plus all workspace typechecks. The previously observed uncommitted tests are
included in the fourth integration. Final freshness, combined acceptance and
deployment remain outstanding.

Recent fixes preserve model accessible names, setup credential observation, exact
historical clipboard wrappers, and demo isolation at native capture and login.
Speed control reports success only when its response confirms the selected tier;
the demo explicitly reports a local simulation. Telegram and action surfaces now
have narrow independent domains; 25 domain boundaries are checked by the ratchet.

Embedded Workspace Settings now load the provider catalog on first use through
the existing cached loader. The previously disabled selector is covered by
live-runtime and demo regressions; 33 complete demo/settings checks pass.
Demo fixtures exercise Resources, Manage and CLI Tools as currently presented.
Retired agent-tool controls and the legacy cleanup no-op are checked separately
at the local demo API boundary, without claiming those controls remain visible.
The new evidence delivery attempt was rejected by Agent Files authentication;
no artifact ID was returned and the older published pack remains historical.

Review evidence routes are now an independent domain (`6f11f701c4`): seven narrow
store methods, event publication and the existing audit callback. Eight standalone
cases plus two integrated characterizations pass, including EMPTY/PASS/WARN/FAIL
precedence, unfinished checks, room isolation, redaction and pagination. The source
comparison confirms the same handler logic and aggregate rule after extraction;
26 domain boundaries pass. The 60% decomposition target was still open at that point (it was met on 2026-10-12; see above).

Global icon selection now reaches 21 more file/settings/widget components. The
89 affected checks pass at `b58fb622c3`; official Material symbols are pinned and
licensed. Responsive fixture isolation and current embedded navigation now pass
167 cases, with29remaining failures in that file. The last complete frontend
result above is historical until its next full run finishes.


## User-requested pause, 2026-10-03

The plan is PAUSED at38%, not completed. [The pause checkpoint](pause-checkpoint-2026-10-03.md) records each package, commits, remaining gates and resume order. The latest complete frontend run at7586cffb54 ended with2438passed/39failed/0pending (exit1). The API rerun at6f11f701c4 was interrupted withSIGINT/exit130 at the user request; it has no complete acceptance result. No owned broad test runner remains active. The previous2170-pass API result is historical. New canonical commits through60ec13dfc0519db5c0033cfb331eab4ec944a8ac and29 observed working paths are not integrated. Final integration must preserve all concurrent changes.

## Continuation v2, 2026-10-10

The plan resumed under the corrected [PLAN v2](plan-v2.md). The paused clone
(101 commits up to `dcb1ed4d1c`) was integrated into main `0365298c0f` as merge
`f103791a06`. Its 17 conflicts were resolved in favor of main's newer behavior:
- Agent Files folders.
- Complete removal of owner auto-login. This is stricter than the clone's loopback-only rule; `AUTH-001` is updated.
- `SpaceToggle` controls.
- The current `AgentSettingsDock`.

No Warm, terminal-resize, cold-pane or instant-UI code was changed. TerminalPane
only receives the two previously approved observer-control patches.

New verification of the current main found issues no review had reported.
Each finding and its evidence is in `review-findings.json`:

- **SEC-007:** `DELETE /api/worktrees` could recursively delete any directory, including
  the live checkout, for any signed-in user. Fixed with a linked-worktree guard
  plus ADMIN/OPERATOR access (`c79de328cb`) and shipped separately as a live hotfix.
- **SEC-008:** project creation ran `mkdir`/`git init` anywhere, and the UI call lacked CSRF.
  Fixed in `5d5c12cb35`.
- **SEC-009:** pane creation still creates arbitrary absolute `cwd` directories. It is open
  because it sits on the user-locked cold-pane path and needs operator approval.
- **OBS-010..012:** fixed in `bc5759616f`:
  - `/livez` is added.
  - `/readyz` checks the database, and `?strict=1` returns 503.
  - Nested credentials are redacted in logs.
  - A behavioral test proves the global limiter reaches every domain module.
- **ARCH:** the dependency ratchet caught three cycles that main had added. They are removed by a
  leaf settings save queue (`c8119852ff`).
- **ADAPTER-006:** Claude is now declared as exact-reference resume, matching main's
  `--resume <uuid>` launcher. Nine runtimes remain provider-selection only.

Test results compared with main, for the same files on the same host:

| Suite | main | after integration |
| --- | --- | --- |
| Web: 6 shell/demo/composer/terminal files | 93 failed | 44 failed |
| Worker | 1 failed | 1 failed (165/166; the same `worker.test.ts` case) |
| Scoped API security/upload/config (30 files) | — | 187/220 on the first loaded run; every failure was a load timeout or a known main failure |

- **Web:** besides the 44 remaining failures, 1 real regression was fixed in `f2a4595f0e`, and 2 tests fail in both runs under new names.
- **Scoped API:**
  - Every failure on the first run was either a load timeout or a known main failure: `room-pane-batch` reports 26 catalog entries where it expects 25.
  - Reruns with long timeouts pass, except the shared failure.

The shared host ran other agents' builds and proofs during these runs. Tests
that exceed their timeout under load are rerun and never counted as passes.

### Second refresh from main (`13ef897af9`), 2026-10-11

Main had moved 84 commits. The refresh merge `ca6b02e95b` keeps main's
operator-approved instant-UI work unchanged:
- `lazyWithPreload` settings cards.
- `RecoverableSurface` wrappers.
- The settings dock in `App.tsx`.

To do that, the earlier extraction of `AgentSettingsDock`/`settings-cards` was dropped
rather than re-implementing protected preload code. The only behavioral remediation
from that extraction is the ADMIN/OPERATOR gate on configuration import and secret
export, which is applied to main's dock.

Other reconciliations:
- `projectsRoot`/`installRoot` are validated by main's T3 Env schema.
- The configuration registry covers main's new `t3Code*` fields; the compile-time registry check caught them.
- The advisory preflight now reports every invalid variable by name, while the runtime parser fails fast.

The dependency ratchet caught four new type-only cycles in main's on-demand icon
packs. The pack modules now import Lucide types directly.

The icon-pack gate found 15 new data, diff and widget components importing Lucide
directly. They now use the shared icon module, which gains 8 Lucide glyphs.

`desktop-shell.test.tsx` fails on main itself (`13ef897af9`). It expects a
`Workspace tools` tab that main's Workspace redesign renamed. It is recorded as
a pre-existing failure, not changed here.

Memory query evaluation was re-run at `ca6b02e95b`:
- recall@5 = 1, MRR = 1, false-positive rate = 0, against thresholds of 0.85 / 0.75 / 0.05.
- Two runs were deterministic.
- The fixture corpus is small: 15 documents and 40 queries. These results do not
  measure retrieval quality at production scale.

The SEC-007 hotfix is live: `267a75817a` was deployed on 2026-10-10 over
`acdf5a4edf`. All 8 services stayed active, the pane-host PID was unchanged, and
the live dist contains the guard. The first attempt was rolled back automatically
by a 15-second demo-readiness probe under load, which this change did not cause.

### Third refresh and verification, 2026-10-11

Main `7542749eab` was merged as `f0f8286ca2`, with one import conflict in the worker.

Test infrastructure:
- The configuration registry flagged two new `dot*` fields from main; they are now registered (`42f7e81c04`).
- A test edit in the remediation branch was stale against main's later Jev fallback change, so main's version of `decisions-service.test.ts` was restored (`52045a6ce4`).

Test-environment facts that affect every agent on public-host:
- `npx vitest` can hang with no CPU use or add more than a minute of startup. Calling `node_modules/.bin/vitest` directly ran the same file in 1.4 s.
- Unix-socket tests need a short `TMPDIR`. Agent-profile temp paths of 53 characters push host socket paths past the 108-byte limit.
- Live deploys reinstall `node_modules`. Worktrees symlink to it, so tests that start during a deploy can fail to load native modules (`node-pty`).
- Several API files (`agent-pane`, `codex-parity`, `cli-codex-model-settings`, `cli-login`, `proof-rooms`) contain tests that wait on real host or CLI behavior. They fail or time out on main and on the integration alike. A single full API run did not finish within 90 minutes on either side, so the results below compare the same files on both sides.

Results, merge versus main on the same host:

| Suite | Merge | Main |
| --- | --- | --- |
| Worker | 1 failure (also fails on main) | 12 failures |
| Web shell/demo/composer/terminal files | 44 failures | 93 failures |
| `cli-runtimes` | 8 failures | 61 failures |

Every other compared API file had no failure that occurs only on the integration.

### Live deployment, 2026-10-11

The integration reached live through the merge queue:
- **Ticket and live commit:** ticket `q-20261011-061431-25ad`, live `4ad6970748`, at 06:51Z. The live guard reported no failures, `live:verify` passed, Gitea and GitHub are synchronized, and the pane-host PID was unchanged.
- **Checks on live:** `/livez`, `/readyz` with `database: RUNNING`, `?strict=1` and the `x-request-id` header.
- **First attempt rolled back:** the deploy-time migration check rejected the already-live `0148` pair. That check now runs only in tests (DATA-002).
- **What this does not certify:** authenticated browser proofs of the file, upload and preview security paths were not repeated on live. The evidence is the scoped regression suites.

### Security batch, decomposition and evidence, 2026-10-11

- **Security batch (live `e496be230a`):** SEC-009, the `SPACE_FILES_HOST_MODE` server switch and SEC-010 (User Mode hides `.env*`, `secrets/`, `var/`, `backups/` and `.git/`).
- **Decomposition (operator approval 2026-10-11):**
  - Proposal steps 1–3 moved the pane-grid helpers, shell utilities, pane dialogs and `PaneCard` out of `App.tsx`.
  - When main changed `PaneCard` in parallel, the same move tool was replayed on main's `App.tsx`. 211/211 declarations stayed verbatim.
  - Five API domains left `app.ts`: admin users, agent tool routing, CLI maintenance, CLI egress/VPN and model providers. Their route suites pass: `agent-tools-routes` and `cli-vpn` 33/33 once `app.close()` gets more than the 10 s hook timeout on the loaded VM; `cli-maintenance`, `google-autoclaim`, `cli-runtime-cache` and `repository-provider-contract-matrix` 299/299; and the provider tests in `api.test.ts` 4/4.
  - Step 4 was analyzed and not applied (see `decomposition-proposal.md`).
- **CORE-006:** `scripts/temporal-replay-check.mjs` replays retained live histories read-only. 85/85 histories replayed without nondeterminism, and the negative control failed 21/21 as intended.
- **ADAPTER-006:**
  - Qoder resumes with the admitted `--continue`.
  - `cli-resume-launch-admission.test.ts` checks every declared resume argv against the wrapper filter and the repository sudoers.
  - The full matrix is in `native-resume-matrix.md`.
- **Test hygiene:** the config preflight test now has a 40 s bound because it runs three tsx children. Two source-text contracts read `PaneCard.tsx`.
- **Live:** ticket `q-20261011-094714-694b`, live `0ff3d53269`. `live:verify` reported no failures and the pane-host PID was unchanged (3567). The first submission returned CONFLICT because the audit follow-up edited `PaneCard`; the merge replayed the moves on the verified `7ad256283f`.
- **Warm proof (`BENCHMARK_WARM_CAPACITY`, 6×16):** capacity and retention pass. Warm latency fails with p95 1150/966 ms against the 250 ms gate, compared with 226/239 ms on 2026-10-07; this is a style-recalculation regression on the first reveal of a hidden room (PERF-001). `BENCHMARK_ROOM_SWITCH` is blocked by the hidden room toolbar on the operator account (TEST-002).
