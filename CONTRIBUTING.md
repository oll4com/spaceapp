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

Contributors can run the complete SpaceApp stack from source with hot-reload in a single command without interfering with an installed SpaceApp instance:

```sh
npm run dev:stack
```

### Lifecycle commands
- **Start stack**: `npm run dev:stack` — Starts PostgreSQL (pgvector) and Temporal in Docker, applies database migrations, builds internal packages, prepares a local `opencode-ai` installation in `.dev-stack/`, and spawns the API (watch mode), the Vite web server, the Temporal worker, and the from-source CLI host.
- **Stop stack**: `npm run dev:stack -- down` — Gracefully stops all child processes and halts the Docker containers.
- **Full reset**: `npm run dev:stack -- reset` — Stops child processes, tears down containers, removes named volumes, and completely purges the `.dev-stack/` state directory.

### Isolation and default ports
The development stack uses its own Docker Compose project (`spaceapp-dev`), a git-ignored state directory (`.dev-stack/`), and ports that do not collide with an installed SpaceApp instance (4910/4911). All services strictly bind to `127.0.0.1`:
- **Web UI**: `http://127.0.0.1:5911` (override via `SPACEAPP_DEV_WEB_PORT`)
- **API Server**: `http://127.0.0.1:5910` (override via `SPACEAPP_DEV_API_PORT`)
- **PostgreSQL**: `127.0.0.1:54329` (override via `SPACEAPP_DEV_POSTGRES_PORT`)
- **Temporal**: `127.0.0.1:57233` (override via `SPACEAPP_DEV_TEMPORAL_PORT`)

### Secrets and owner setup
All credentials (database password, session secret, setup token) are generated inside `.dev-stack/secrets/` with strict mode `0600`. They are never printed, apart from the one-time owner setup token.
Once the stack finishes starting, it prints the URL and setup token. Open `http://127.0.0.1:5911`, enter your email and password along with the setup token to create the initial owner account.

### Hot reloading & CLI panes
- Changes to `apps/api/src/` automatically restart the API server.
- Changes to `apps/web/src/` are hot-reloaded by Vite in the browser.
- OpenCode runs through the from-source CLI host using the pinned `opencode-ai` version in `.dev-stack/`, without needing global installation or paid AI provider credentials.
- When editing code in `packages/*`, run `npm run build:packages` (or `npm run build -w <package-name>`) to recompile the shared artifacts used by the running stack.

### Platform notes
- **Linux**: Requires Docker or rootless Podman (with docker-compose plugin) and Node.js.
- **macOS**: Supported with Docker Desktop or Colima (`colima start`).
- **Windows 11**: Run inside WSL2 (Ubuntu 22.04/24.04 recommended).

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
