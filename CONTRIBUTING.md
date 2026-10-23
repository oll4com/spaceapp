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

To run the full interactive SpaceApp stack (PostgreSQL with pgvector, Temporal,
database migrations, CLI host, API server, background worker, and the Vite web
UI with hot reload) from your source checkout without pulling the published
application container images:

### Prerequisites

- Node **>=22.12 <23** and npm (`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci` already completed)
- Docker with Compose v2 (`docker compose version`) running on the local host
- Available loopback ports `5911` (web), `5910` (API), `55432` (PostgreSQL), and `57233` (Temporal gRPC), which do not collide with an installed SpaceApp on `4910`/`4911` (or override via environment variables)

### Platform notes

- **Linux:** Native reference environment. Ensure your user can access the local Docker daemon and that `python3`, `make`, and a C++ toolchain are installed if `node-pty` needs to build from source.
- **macOS:** Start Docker Desktop or Colima (`colima start`) before running `npm run dev:stack`. Ensure Xcode Command Line Tools (`xcode-select --install`) are present so `node-pty` and Unix domain sockets under `.dev-stack/runtime/` work cleanly.
- **Windows 11 (WSL2):** Clone the repository inside your WSL2 Linux filesystem (for example `~/spaceapp`, not `/mnt/c/...`) and run `npm run dev:stack` inside WSL2 with Docker Desktop WSL2 integration or a native Linux Docker engine enabled. Running inside WSL2 provides native Unix domain sockets for `@space/cli-host` (`cli-host.sock`) and enforces `0600` secret file permissions.

### Start the stack

```sh
npm run dev:stack
```

`npm run dev:stack` (or `npm run dev:stack -- up --detach` for background
mode) performs the following steps:

1. Creates `.dev-stack/` with `0600` secrets (`postgres-password`, `session-secret`, `setup-token`, and `database-url`) and local runtime directories (`data/`, `workspaces/`, `artifacts/`, `logs/`, `pids/`, `runtime/`).
2. Ensures the pinned OpenCode CLI version from `Dockerfile` is installed inside `.dev-stack/tools/opencode/` and exposes the provider parity wrappers in `.dev-stack/bin/` so the default Getting Started room and OpenCode CLI panes work out of the box.
3. Builds internal `@space/*` workspace packages in topological order and starts digest-pinned PostgreSQL (`pgvector/pgvector`) and Temporal containers from `packages/run-spaceapp/templates/compose.yml` bound exclusively to `127.0.0.1`.
4. Runs `@space/db` database migrations against the local PostgreSQL instance.
5. Starts `@space/cli-host`, `@space/api`, `@space/worker`, and `@space/web` from source with watch/HMR enabled, waits for `/livez`, `/readyz` (`database`, `worker`, and `cliHost` all `RUNNING`), and the web proxy (`http://127.0.0.1:5911/api/setup/status`), and prints the web URL and one-time owner setup token.

Open `http://127.0.0.1:5911` in your browser and paste the printed setup token
to claim the local owner account. On first owner claim, the setup token file in
`.dev-stack/secrets/setup-token` is automatically consumed and removed.

### Verify, stop, and reset

Run an automated end-to-end smoke check against the running stack (verifies
`/readyz`, claims the owner account if unclaimed, opens the Getting Started
room's OpenCode CLI pane, starts a live PTY session, and attaches its terminal
WebSocket). By default, `verify` claims or logs in with `owner@example.com`; if
you already claimed the owner account in the browser with custom credentials,
pass `SPACE_DEV_OWNER_EMAIL` and `SPACE_DEV_OWNER_PASSWORD`:

```sh
npm run dev:stack -- verify
```

Stop the host dev servers and the PostgreSQL/Temporal containers while keeping
your `.dev-stack/` database volume and secrets for the next session:

```sh
npm run dev:stack -- down
```

Stop all processes/containers and wipe `.dev-stack/` along with the PostgreSQL
volume to return to a clean first-run state:

```sh
npm run dev:stack -- reset
```

Check JSON status of the managed services and ports at any time:

```sh
npm run dev:stack -- status
```

### Port overrides

All services bind to `127.0.0.1`. Override any default host port when running
alongside other local services:

```sh
SPACE_DEV_WEB_PORT=4921 SPACE_DEV_API_PORT=4920 SPACE_DEV_POSTGRES_PORT=55433 SPACE_DEV_TEMPORAL_PORT=57234 npm run dev:stack
```

You can also override the state directory location with `SPACE_DEV_STATE_DIR`.

### Troubleshooting

- **Port already in use:** Run `npm run dev:stack -- status` or `npm run dev:stack -- down` to stop an existing stack, or set `SPACE_DEV_WEB_PORT` / `SPACE_DEV_API_PORT` / `SPACE_DEV_POSTGRES_PORT` / `SPACE_DEV_TEMPORAL_PORT`.
- **Inspecting service logs:** Per-service logs are written to `.dev-stack/logs/cli-host.log`, `.dev-stack/logs/api.log`, `.dev-stack/logs/worker.log`, and `.dev-stack/logs/web.log`.
- **Lost owner setup token or password:** Run `npm run dev:stack -- reset` to wipe local dev state and generate a fresh setup token on the next `npm run dev:stack`.

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

## License of contributions

SpaceApp is licensed under the [MIT License](LICENSE). Contributions are
accepted under the same license (inbound = outbound): by submitting a
contribution you license it to everyone under the MIT License. You keep the
copyright of your contribution.

Every commit must carry a `Signed-off-by:` line with your real name and email,
which certifies the [Developer Certificate of Origin 1.1](https://developercertificate.org/):
that you wrote the contribution or have the right to submit it under the MIT
License. `git commit -s` adds the line. There is no separate contributor
license agreement.
