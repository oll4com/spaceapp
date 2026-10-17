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

To start the entire SpaceApp stack from source with hot reload (PostgreSQL with
`pgvector`, Temporal, database migrations, the CLI host on a Unix socket with
pinned OpenCode CLI, the Temporal worker, the API in watch mode, and the Vite
web dev server):

### Prerequisites

- Node **>=22.12 <23** and npm (`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`).
- Docker with the Compose v2 plugin (`docker compose version`) running for
  PostgreSQL and Temporal.

### Commands

```sh
npm run dev:stack
npm run dev:stack -- down
npm run dev:stack -- reset
```

- `npm run dev:stack` starts PostgreSQL and Temporal in Docker (using the exact
  digest-pinned images from `packages/run-spaceapp/templates/compose.yml`),
  builds the internal `@space/*` packages, runs the database migrations, installs
  the pinned `opencode-ai` CLI from `Dockerfile` into `.dev-stack/cli/vendor/opencode`,
  starts the CLI host, Temporal worker, API and Vite dev server, waits for
  `/readyz` to report `ok: true` with workflows running, and prints the local
  URL and one-time owner setup token.
- Open the printed URL (`http://127.0.0.1:14911` by default), paste the setup
  token to create the owner account, open the **Getting Started** room, and
  start an **OpenCode** CLI pane (no AI provider account is needed to reach the
  OpenCode terminal UI).
- Editing `apps/web/src` hot-reloads in the browser, editing `apps/api/src`
  restarts the API, and editing `packages/*/src` or `apps/worker/src`
  automatically rebuilds the affected workspace and restarts the worker or CLI
  host.
- `npm run dev:stack -- down` stops all processes and Docker containers while
  keeping the `.dev-stack/` state directory and database volume.
- `npm run dev:stack -- reset` stops everything and removes only the containers,
  volumes, Unix socket directory, and `.dev-stack/` state directory created by
  `dev:stack`.

### Default ports and isolation

`dev:stack` uses its own Docker Compose project (`spaceapp-dev-stack`), its own
git-ignored state directory (`.dev-stack/`), and ports that do not collide with
an installed SpaceApp instance on `4910`/`4911`. Every listening port binds to
`127.0.0.1` only:

| Service | Default address | Environment override |
| :--- | :--- | :--- |
| Web (Vite dev server) | `127.0.0.1:14911` | `SPACE_DEV_WEB_PORT` |
| API (`@space/api`) | `127.0.0.1:14910` | `SPACE_DEV_API_PORT` |
| PostgreSQL (`pgvector`) | `127.0.0.1:15432` | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | `127.0.0.1:17233` | `SPACE_DEV_TEMPORAL_PORT` |

State directory and Compose project name can also be overridden with
`SPACE_DEV_STACK_STATE_DIR` and `SPACE_DEV_STACK_COMPOSE_PROJECT`. Secrets
(`postgres-password`, `session-secret`, `setup-token`, `database-url`) are
generated per state directory with mode `0600`; only the setup token is printed.
The browser service (`packages/browser-host`) and optional companion CLIs stay
disabled in `dev:stack`.

### Platform notes

- **Linux**: Works directly with Docker Engine and the Compose plugin. Ensure
  your user can access the Docker socket without interactive `sudo` prompts.
- **macOS**: Start **Docker Desktop** or **Colima** (`colima start`) before
  running `npm run dev:stack`. If `node-pty` needs to compile from source, make
  sure Xcode Command Line Tools (`xcode-select --install`) are installed.
- **Windows 11 (WSL2)**: Run `git clone`, `npm ci`, and `npm run dev:stack`
  inside your WSL2 Linux distribution (for example Ubuntu 24.04) with either
  Docker Engine running inside WSL2 or Docker Desktop's WSL2 integration
  enabled. Keep the checkout on the Linux filesystem (`~/...`) for the fastest
  file watching and native POSIX file permissions; `dev:stack` places its CLI
  host Unix socket in the Linux temporary directory so socket path limits and
  `/mnt/*` mounts do not block PTY sessions.

### Troubleshooting

- **Port already in use**: Set `SPACE_DEV_WEB_PORT`, `SPACE_DEV_API_PORT`,
  `SPACE_DEV_POSTGRES_PORT`, or `SPACE_DEV_TEMPORAL_PORT` to free ports above
  `1024`.
- **Unix socket path too long**: Set `SPACE_DEV_CLI_SOCKET_DIR=/tmp/space-dev`
  so the socket path stays under 100 bytes.
- **Stale state or forgotten owner password**: Run `npm run dev:stack -- reset`
  to wipe `.dev-stack/` and the dev database volume, then start fresh with
  `npm run dev:stack`.

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
