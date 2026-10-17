# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.

The `run-spaceapp` installer is a separate package with its own host Node
requirement. Installing the application and developing this monorepo have
different prerequisites; consult the selected installer's `engines` field.

From the repository root, install the locked dependencies:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

Skipping the Electron download is suitable for core development. Desktop
packaging requires its normal toolchain and separate platform acceptance.
Dependency installation may use the network; the smoke command below does not
need a provider account, API key, Docker, PostgreSQL or Temporal.

## Run the full app from source

This contributor stack runs the API, web dev server, Temporal worker and CLI
host from **this checkout**. Only PostgreSQL/pgvector and Temporal run in Docker.
Use Node >=22.12 <23, npm, Docker with Compose v2 (`docker compose version`),
and a C++ toolchain/Python/Make if `node-pty` needs a native build. Complete the
locked `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` first. No operator installation,
provider account or global OpenCode install is used.

```sh
npm run dev:stack                 # foreground, including a non-TTY terminal
# Open the printed loopback URL, use the one-time token, create owner, sign in.
# Open Getting Started and its OpenCode CLI pane.
npm run dev:stack -- verify       # fresh synthetic test owner only; see below
npm run dev:stack -- down         # another terminal; retain DB volume/state
npm run dev:stack -- rebuild      # restart after changes in packages/* or worker
npm run dev:stack -- reset        # destructive: ONLY this owned dev-stack state
```

Default loopback ports: API5910, web5911, PostgreSQL55432, Temporal57233. Override
before first startup with `SPACE_DEV_API_PORT`, `SPACE_DEV_WEB_PORT`,
`SPACE_DEV_POSTGRES_PORT`, `SPACE_DEV_TEMPORAL_PORT`. Ports must be distinct and
not4910/4911. Once state exists, use its saved ports or explicitly stop/reset
before changing them. Vite proxies API/terminal WebSockets to that stack's API.
API source changes restart under `tsx watch`; web source changes hot reload.
The single `rebuild` command rebuilds packages and restarts every source service.

Each checkout gets an unpredictable Compose project and fixed `.dev-stack/`,
git-ignored. Its ownership marker binds its canonical checkout path. Generated
database password, session secret and setup token are0600, under0700 directories
on POSIX. The owner token is the only secret deliberately printed; it is valid
for initial owner setup for15minutes after API startup, not a dev-login shortcut.
Do not share the token or commit/copy runtime files. OpenCode is pinned to the
version declared in Dockerfile and installed only beneath that state directory.
Its provider config/cache/home are also isolated there. Reaching its terminal
does not establish model availability or a successful AI completion.

On macOS, start Docker Desktop or Colima and confirm `docker info` works from the
same terminal. The runner uses the existing Docker context without passing its
configuration to application/provider children. On Windows11, use WSL2 with a
Linux filesystem checkout (for example `~/spaceapp`), Node22 and Docker Desktop
WSL integration or a working Docker daemon in that distribution. Native Windows
is refused, and no Windows feature, WSL distribution or daemon is installed by
the stack. Keep the checkout path short enough for the Unix CLI socket
`.dev-stack/h.sock` (at most100bytes); do not use an existing operator socket.

Before starting or rebuilding on macOS, the development bootstrap checks the
locked `node-pty@1.1.0` actually loaded from this checkout. Its published helper
can be present as0644, which imports successfully but cannot spawn a PTY. Only
that bounded regular, single-link, current-user-owned adjacent helper may gain
the owner-execute bit (0644 to0744), through a no-follow descriptor with inode,
mode and unchanged-content verification. Safe already-executable helpers are
left untouched. Unexpected versions, links, ownership or permissions fail
explicitly; nothing is installed/upgraded or recursively chmodded. Linux is a
no-op; the normal product runtime is unchanged. `down/reset/verify` do not run
this prerequisite. Reset removes the development state, not installed npm
dependencies or this retained prerequisite mode; `npm ci` reinstalls them.

Readiness requires `/readyz?strict=1`, HTTP200 **and** `ok:true` with PostgreSQL,
worker and CLI host RUNNING. The supervisor reports a child exit and stops the
other owned children; Docker failures are failures, not successful cleanup.
`down/reset` compare process creation identity before signalling. An unknown,
foreign or altered state, reused PID, orphan group, missing ownership receipt,
remaining resource or broken/outside symlink refuses cleanup for inspection.
Do not delete the lock or broaden paths to suppress such a failure. This is a
trusted-local-checkout guard, not a hostile-writer or power-loss guarantee.

Shutdown attempts one birth/group-checked signal per immutable launch receipt;
the signal handler and final cleanup share that observation, including any first
failure. A delivered signal or absent leader does not certify group cleanup.
Group probes may re-observe EPERM within the existing ten-second deadline, but
only a fresh all-groups ESRCH observation succeeds; persistent denial stays a
failure. Lifecycle cancellation covers acquisition and pre-up teardown, then
hands off only after the source supervisor installs its own handlers. An
interrupted rebuild does not start a new stack, releases only its exact admission
lease, and may retain runtime recovery state. CI does not attempt a concurrent
reset until its current supervisor has an observed exit. No lock recovery,
permission relaxation or larger timeout is implied by this behaviour.

`verify` is intended for an isolated fresh test checkout. It creates a synthetic
owner through the ordinary one-time setup, signs in, observes the real starter
room, opens OpenCode through the real source CLI host and inspects the terminal
transport. Never point it at personal/operator data. This probe is not a browser
screenshot, model task, cross-platform execution or full acceptance by itself.
The full issue65 acceptance additionally requires actual Linux and macOS/WSL2
output, visible UI/hot-reload/failure/cleanup evidence and the normal repository
checks; do not call the feature accepted from helper tests or a prepared CI file.

The opt-in `scripts/dev-stack-ci.mjs` proof is restricted to an isolated Linux
or macOS CI checkout with fresh state. On Linux it additionally uses an already
installed Chrome/Chromium binary, a new private profile and the ordinary web
login to observe the real pane/xterm, save synthetic PNGs and edit/restore the
original instance-badge component while checking same-document React HMR.
This is a test browser, not the optional application browser service. No browser
is installed by the script; a missing binary is an explicit failing prerequisite.
macOS records that browser part as not performed rather than reporting a pass.

Both native jobs temporarily edit/restore the original API liveness module to
observe `tsx watch`, then edit/restore `packages/runtime/src/index.ts` and invoke
the documented `rebuild` command. A new worker must load the rebuilt package;
project, ports, generated secrets, owner, starter room and pane must persist.
Source bytes are restored in `finally`; the temporary compiled package probe
remains only in the disposable CI checkout until disposal. The proof then
checks explicit worker failure and owned reset. Screenshots require visual
review; geometry or CI green alone does not certify the full OpenCode UI.
Combine actual Linux and macOS results for the same commit before claiming
cross-platform acceptance. These scripts do not submit provider input or a
model task and must not be used against an operator checkout.

### First executed task, without a provider

```sh
npm run smoke:offline
```

This builds the CLI host and runs an explicitly **simulated runtime** through
the real Unix socket protocol and a real PTY child. It submits two arithmetic
tasks, checks their results, reconnects without replacing the process, and
resubmits an input key to verify duplicate suppression within that host's
retained session. The child receives an allowlisted environment. Its process,
socket and temporary directory are removed before success is reported.

Success is a JSON record with `mode: "SIMULATED_RUNTIME"`, `passed: true` and
`cleaned: true`. A wrong answer or early child exit fails the command. This is
a contributor transport/acceptance check, not evidence of AI quality, provider
authentication, native task resume, browser behavior or crash durability.

Unix socket paths are short. If your inherited `TMPDIR` is deeply nested,
select a short temporary directory you own and set `TMPDIR` for the command.
On Windows run this particular smoke check inside WSL or a Linux development
container. It does not certify the Windows/macOS installer.

## Make and verify a small change

### Isolated native transport diagnosis

The temporary contributor branch `diagnostics/issue-65-native-pty-nexo` routes
pushes to one bounded standard macOS job in `dev-stack.yml`. It installs the
locked dependencies, reports only the loaded native binding's relative path
and adjacent `spawn-helper` metadata without repairing either, builds the
original CLI host, and runs the original `test:contributor` positive and
negative controls. No Docker, API, browser, OpenCode install or provider is
started by this job. An executable helper or successful native import alone
does not prove that a PTY can start.

Following the observed non-executable helper and native test failure, the
diagnostic job requires that exact failing baseline, then changes **only** the
owner-execute bit on the one pinned runner-owned helper through an open
no-follow descriptor. It reruns the unchanged tests and always restores the
original mode and verifies unchanged bytes. This is a bounded counterfactual,
not an automatic repair or a reason to chmod host/dependency trees. Different
baseline conditions fail explicitly rather than being silently repaired.
After restoration, the same native failure must recur (A/B/A control); success
requires the exact failing/passing/failing sequence and unchanged helper bytes.

Its result concerns a **simulated runtime over real PTY/Unix IPC** only, not
the source-stack terminal failure's historical cause or full issue acceptance.
Ordinary feature pushes, pull requests and manual workflow runs retain the
full source jobs. Do not substitute this diagnostic job for their evidence.

### Small changes

Work on a branch, not on `main`, so the change can become a pull request:

```sh
git switch -c my-change
```

For example, change the synthetic task's result handling in
`scripts/fixtures/offline-cli.mjs`, then run:

```sh
npm run test:contributor
npm run check
```

The contributor regression tests reject incorrect task output and early process
exit, and check cleanup after both. Restore the intended behavior before
submitting a change. Use the tests for the affected workspace as well; the
offline smoke is not a substitute for them.

## Checks before a commit

After `npm ci`, these commands work in this order, also on a fresh clone:

```sh
npm run check
npm test
npm run build
npm run hygiene:preflight
```

`npm run check` runs the dependency boundary check, builds the internal
`@space/*` packages in dependency order and then type-checks the apps, so it
does not need an earlier `npm run build`. `npm test` builds the internal
packages and runs the test suites in this checkout. `npm run build` also builds
the API, worker and web app. Run `npm run hygiene:preflight` before every
commit: it fails on untracked files and on staged runtime, secret, dependency,
generated or report paths. Commit from your branch; older releases of this
check also refuse to run on `main`.

Opt-in database and authenticated provider proofs require separate isolated
fixtures; skipped proofs are not passing evidence.

In the maintainers' source repository, `npm run check:claims` compares the
version, licence, Node requirement, runtime list and key constants stated in
the README and `docs/` with the code, and rejects unqualified latency or
isolation claims; maintainers run it when a change touches any of them. Current
results and known failures are indexed there in `docs/quality/README.md`, and
its `AGENTS.md` describes the guidance to read before changing session
attachment, room retention, control, readiness, polling or deployment.

Keep changes reviewable and include the exact commands and limitations of your
verification. Never include credentials, private transcripts or local runtime
state in a contribution.
