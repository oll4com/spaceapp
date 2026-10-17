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
1. Generates an isolated state directory in `.dev-stack/` with secure 0600 credentials.
2. Automatically extracts and starts containerized dependencies using the pinned image digests from the compose template.
3. Installs the pinned OpenCode CLI locally in `.dev-stack/opencode` providing a fully isolated terminal interface without polluting global `PATH`.
4. Builds internal monorepo packages (`@space/*`).
5. Runs database migrations against the isolated development database.
6. Starts the background Temporal worker, API service, and Vite web development server with hot-module replacement.

### Development service endpoints

| Service | Local Endpoint | Description |
| --- | --- | --- |
| **Web UI** | `http://127.0.0.1:5911` | Vite web frontend with HMR & API proxy |
| **API Server** | `http://127.0.0.1:5910` | Fastify API backend (`/readyz`, `/api/*`) |
| **PostgreSQL** | `127.0.0.1:54329` | Isolated pgvector database |
| **Temporal gRPC** | `127.0.0.1:57233` | Temporal workflow engine gRPC endpoint |

### Stopping, inspecting, and resetting the stack

- **Check status**:
  ```sh
  npm run dev:stack -- status
  ```
- **Verify health endpoints**:
  ```sh
  npm run dev:stack -- verify
  ```
- **Stop stack (preserves database state)**:
  Press `Ctrl+C` in the terminal where `dev:stack` is running, or execute:
  ```sh
  npm run dev:stack -- down
  ```
- **Reset stack (purges database and ephemeral secrets)**:
  ```sh
  npm run dev:stack -- reset
  ```

### Configuration & Environment Overrides

The development stack runs isolated defaults out of the box, but can be customized with environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `SPACE_DEV_WEB_PORT` | `5911` | Host port bound to Vite Web UI |
| `SPACE_DEV_API_PORT` | `5910` | Host port bound to Fastify API server |
| `SPACE_DEV_POSTGRES_PORT` | `54329` | Host loopback port for PostgreSQL |
| `SPACE_DEV_TEMPORAL_PORT` | `57233` | Host loopback port for Temporal gRPC |
| `SPACE_DEV_STATE_DIR` | `.dev-stack` | Root directory for isolated secrets, logs, and runtimes |

### Package development and hot reload

- **Frontend (Web UI)**: Vite provides instant Hot Module Replacement (HMR) for edits in `apps/web`.
- **Internal packages (`packages/*`)**: To continuously compile `@space/*` packages while making changes across packages, run:
  ```sh
  npm run watch:packages
  ```
  Because the background worker and CLI host run plain Node.js, they load compiled modules at process startup. After modifying monorepo packages, apply the updates across all running services by restarting the stack:
  ```sh
  npm run dev:stack -- down && npm run dev:stack
  ```

### Troubleshooting

- **Docker daemon / Compose**: Ensure Docker is running (`docker info`) and the compose plugin is accessible (`docker compose version`). On Linux, ensure your user belongs to the `docker` group or has permission to communicate with the Docker socket.
- **Port conflicts**: By default, `dev:stack` binds loopback ports `5911` (Web), `5910` (API), `54329` (Postgres), and `57233` (Temporal). If a port is occupied by another application, override it using environment variables (e.g. `SPACE_DEV_WEB_PORT=5921 SPACE_DEV_API_PORT=5920 npm run dev:stack`).
- **Permissions and state directory**: State and credentials reside in `.dev-stack/` with owner-only `0600` permissions. If you encounter permission errors or need a fresh state, run `npm run dev:stack -- reset`.
- **Service readiness timeouts**: On slower machines or initial image pull, container initialization may take longer. You can monitor container logs via `docker compose -p <project-name> -f .dev-stack/docker-compose.yml logs -f` using the project name displayed at startup or via `npm run dev:stack -- status` (default: `spaceapp-dev-<hash>`).
- **macOS (Colima / Docker Desktop)**: Ensure port forwarding and loopback bindings `127.0.0.1` are enabled. If using Colima, verify `colima status` and ensure adequate memory allocation (>= 4GB recommended).
- **Windows 11 (WSL2)**: Run `npm run dev:stack` inside your WSL2 Linux distribution (e.g. Ubuntu) with Docker Desktop WSL2 integration enabled or Docker Engine running inside WSL2. Native Windows command prompt lacks POSIX permission primitives for 0600 secret files.

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
