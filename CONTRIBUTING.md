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

## First executed task, without a provider

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

## Run the full app from source

Use Node from `.nvmrc`, the locked dependencies above, and Docker Engine with
the Compose plugin (`docker info` and `docker compose version` must succeed).
Compose 2.20 or newer is required. This runs PostgreSQL with pgvector and
Temporal in Docker; API, CLI host, worker and Vite run on your host from this
checkout. No application image rebuild or AI provider account is needed.

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
```

On a fresh checkout the command downloads the digest-pinned dependency images,
builds the internal packages and worker, installs the Dockerfile-pinned
`opencode-ai` locally, applies migrations, and waits for both API and Vite
readiness. The first start can take several minutes. It prints the browser URL
and one-time owner setup token. Open that URL, create the owner using the token,
sign in and open the **Getting Started** room's OpenCode pane. The token has the
normal 15-minute setup lifetime after API startup; it cannot claim a second
owner. Subsequent starts retain your account and data.

The supervisor stays in the foreground, also without a TTY. Service logs are in
`.dev-stack/logs/`; unexpected process exits name the failed service, stop the
rest and exit nonzero. Docker health is monitored too. API source edits restart
the API through `tsx watch`; web source edits use Vite HMR. After editing
`packages/*` or `apps/worker/src`, run the following in a second terminal:

```sh
npm run dev:stack -- rebuild
```

This single command rebuilds the internal packages and worker in dependency
order, then restarts the source services and waits for readiness. Existing
terminal processes stop during this restart; reopen their panes afterwards.
Build failures stop the stack and retain logs and data for diagnosis.

| Command | Result |
| --- | --- |
| `npm run dev:stack` | Start the foreground supervisor |
| `npm run dev:stack -- status` | Report the saved ports and supervised processes |
| `npm run dev:stack -- verify` | Read-only checks of API and Vite `/readyz` |
| `npm run dev:stack -- rebuild` | Recompile packages and worker; restart source services |
| `npm run dev:stack -- down` | Stop processes and containers, retain data |
| `npm run dev:stack -- reset` | Stop and remove this stack's containers, volumes and state |

Ctrl+C and terminal hangup (SIGHUP) have the same stop behavior as `down`.
Reset does not run Docker prune,
remove shared images or touch an installed SpaceApp. A failed Docker teardown
keeps the ownership manifest and secrets so it can be retried.

| Service | Default loopback port | Override at first start |
| --- | --- | --- |
| Web / Vite | 5911 | `SPACE_DEV_WEB_PORT` |
| API | 5910 | `SPACE_DEV_API_PORT` |
| PostgreSQL | 55432 | `SPACE_DEV_POSTGRES_PORT` |
| Temporal gRPC | 57233 | `SPACE_DEV_TEMPORAL_PORT` |

Every published port binds to `127.0.0.1`. Values must be distinct, unprivileged
ports, excluding installed ports 4910/4911. Ports are saved and reused by later
commands; reset before changing them. For example:

```sh
SPACE_DEV_API_PORT=6010 SPACE_DEV_WEB_PORT=6011 npm run dev:stack
npm run dev:stack -- verify
npm run dev:stack -- down
```

Space Memory uses the current `space_memory.md` and `space_memory_monthly.md`
templates. When upgrading an existing dev state, its older `gemini_history*.md`
files are copied to those names only if the new files are absent; private edits
and the old files are retained. No installed-instance memory is imported.

The ignored `.dev-stack/` directory owns the database secrets (0600), provider
homes, wrappers, logs and tools. Temporal receives its password through a 0600
Compose environment file so no world-readable secret mount is needed. A unique
Compose project is derived from the state path. `SPACE_INSTANCE=dev` isolates
the session cookie and disables background jobs that act on external systems.
Installed `SPACE_*` configuration and provider account keys are not inherited.
Vite dotenv loading is disabled for the isolated stack; standalone Web development
keeps its normal dotenv behavior. Managed state directories refuse symbolic links,
and private files refuse symbolic links, hard links and foreign owners before use.
Logs use owned 0600 file descriptors; long lines are flushed with bounded buffering
while generated secrets remain redacted, even across output chunks.
Short, private temporary directories for CLI/control sockets and tsx IPC are
recorded in the manifest and removed by reset. Keeping `TMPDIR` short also
prevents truncated Unix socket paths from colliding in deep Linux checkouts.

For another disposable stack set `SPACE_DEV_STATE_DIR=.dev-stack-NAME` on
**every** command. Only `.dev-stack` and sibling `.dev-stack-NAME` directories
inside this checkout are accepted, preventing reset from adopting an arbitrary
folder. Existing nonempty directories without an ownership manifest and
symlink state paths are refused.

Run only a trusted checkout: build scripts, Docker and source services execute with
your user's privileges. These isolation checks protect installed data and reject
unsafe existing state; they do not sandbox arbitrary source code or concurrent
filesystem changes made by another process running as your user.

The source stack supports the OpenCode terminal UI; opening it does not run an
AI model probe or certify provider inference. Configure providers in its
isolated home if needed. Other provider wrappers, browser service, optional
companions, demo servers and root-only features stay disabled. Google OAuth
configuration is disabled too; it cannot write credentials into an installed
instance. Plugin data, personal Git workspaces, live audit logs and DOCX work files use
private state paths; installed legacy history and personal memory are not imported; development plugin changes do not synchronize installed CLI skills.

Platform notes and troubleshooting:

- **Linux:** install Docker Engine and its Compose plugin; Python 3, Make and a
  C++ compiler are needed if `node-pty` has no compatible prebuilt binary.
- **macOS:** use Docker Desktop or a running Colima VM. With Colima, install the
  Docker CLI and Compose plugin too. Confirm `docker compose version`, not just
  `docker info`. Run npm on the Mac; this tests the real host PTY and sockets.
- **Windows 11:** use WSL2 with Docker Desktop's WSL integration. Clone, install
  dependencies and run all commands inside the Linux filesystem of WSL2.
  Native PowerShell/Windows is not supported by this Unix socket stack.
- **Occupied port:** select another port before first start, or a new named
  state directory. Vite uses strict ports instead of silently selecting another.
- **Startup failure:** read the named log in `.dev-stack/logs/`. After fixing
  the cause, rerun the command. A build or migration failure is not readiness.
- **Docker unavailable during cleanup:** restart Docker and retry `down` or
  `reset` with the same state directory. Do not delete its secrets manually.
- **Unexpected host or supervisor crash:** rerun `down`/`reset`; saved process
  identities are checked before signaling. Recycled PIDs are skipped without
  blocking cleanup of the remaining owned processes.
  PTY descendant identities are captured while their host is alive so recovery
  can also stop recorded children reparented by a host crash.
- **Platform coverage:** existing host analytics and some filesystem tests use
  Linux `/proc` interfaces. The source stack does not emulate those interfaces
  on macOS; Linux remains the reference for the complete workspace suite. The
  optional T3 startup-assets probe returns 404 while that service is disabled.

`npm run test:dev-stack` runs focused unit and real-process regression tests.
`npm run smoke:dev-stack` runs a **disposable** non-TTY integration fixture with
its own ports and `.dev-stack-smoke-*` state: readiness, owner claim and sign-in,
CSRF, Getting Started, real OpenCode PTY output over the Vite WebSocket proxy,
API watch, shared-package rebuild, worker failure and reset cleanup. It restores
source files edited for reload checks on completion and on SIGINT, SIGTERM or
SIGHUP; SIGKILL cannot be caught. Use a checkout with no concurrent source
edits. After an interrupt, follow the printed state-directory instructions to
run `reset` for any remaining Docker resources. The Ubuntu CI job runs this
path directly after `npm ci`, without a build that could hide missing startup
steps.

## Make and verify a small change

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
