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

Contributors can run the complete SpaceApp stack locally from source with a single command without installing global tools or colliding with production/operator instances.

### Prerequisites

- **Node.js**: `>=22.12 <23` and npm.
- **Docker Engine**: Docker Desktop, Rancher Desktop, Colima (macOS), or native Linux Docker with Compose plugin (`docker compose`).
  - *Linux*: Native Docker daemon with compose plugin.
  - *macOS*: Docker Desktop or Colima.
  - *Windows 11*: WSL2 with Docker Desktop WSL2 backend or Docker Engine inside WSL2.

### Starting the stack

```sh
npm run dev:stack
```

This single command:
1. Validates prerequisites (`node`, `docker`, and docker compose plugin).
2. Generates an isolated state directory in `.dev-stack/` with secure 0600 credentials.
3. Automatically pins and starts containerized dependencies (`pgvector/pgvector:pg16` and `temporalio/auto-setup`).
4. Installs the pinned OpenCode CLI locally in `.dev-stack/opencode` (with VS Code parity) without polluting global `PATH`.
5. Builds internal monorepo packages (`@space/*`).
6. Runs database migrations against the isolated development database.
7. Starts the background Temporal worker, API service, and Vite web development server with hot-module replacement.

### Development service endpoints

| Service | Local Endpoint | Description |
| --- | --- | --- |
| **Web UI** | `http://127.0.0.1:5911` | Vite web frontend with HMR & API proxy |
| **API Server** | `http://127.0.0.1:5910` | Fastify API backend (`/readyz`, `/api/*`) |
| **PostgreSQL** | `127.0.0.1:54329` | Isolated pgvector database |
| **Temporal UI / gRPC** | `127.0.0.1:57233` | Temporal workflow engine |

### Stopping and resetting the stack

- **Stop stack (preserves database state)**:
  Press `Ctrl+C` in the terminal where `dev:stack` is running, or execute:
  ```sh
  npm run dev:stack -- down
  ```
- **Reset stack (purges database and ephemeral secrets)**:
  ```sh
  npm run dev:stack -- reset
  ```

### Watching monorepo packages

When modifying code in `packages/*`, run the package builder in watch mode in a separate terminal:
```sh
npm run watch:packages
```
This automatically rebuilds `@space/*` packages on changes so the running API server and worker pick up updates.

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
