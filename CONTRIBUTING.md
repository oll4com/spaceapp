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

Contributors can run the complete SpaceApp stack—including PostgreSQL with pgvector,
Temporal, hot-reloading API and web dev servers, the Temporal worker, and the CLI host—with
a single command.

### Prerequisites

- **Node.js**: `>=22.12 <23` and npm
- **Docker**: Docker Engine or Docker Desktop with Compose v2
- Locked dependencies installed via `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`

### Quick start

```sh
# Start the full stack from source
npm run dev:stack

# Stop all processes and Docker containers
npm run dev:stack -- down

# Remove containers, volumes, and state directory
npm run dev:stack -- reset
```

When started, the command:
1. Boots PostgreSQL (pgvector) and Temporal in Docker using the exact digests pinned in `packages/run-spaceapp/templates/compose.yml`.
2. Automatically generates isolated secrets (database password, session secret, setup token) in `.dev-stack/secrets/` with mode `0600`.
3. Installs the pinned `opencode-ai` CLI from `Dockerfile` into the local state directory and sets up the parity wrapper.
4. Applies all pending database migrations (`npm run db:migrate`).
5. Spawns the CLI host, Temporal worker, API (watch mode with tsx), and Vite web dev server from source.
6. Waits for `/readyz` health verification and prints the local Web URL and one-time owner setup token:

```
================================================================================
 SpaceApp dev stack is running from source!

 Web URL:               http://127.0.0.1:4921
 API URL:               http://127.0.0.1:4920
 Ready Check:           http://127.0.0.1:4920/readyz
 One-Time Setup Token:  <generated-token>

 Press Ctrl+C or run 'npm run dev:stack -- down' to stop.
================================================================================
```

Open the printed Web URL in your browser, enter the setup token to complete initial owner registration, open the **Getting Started** room, and interact with the OpenCode pane. Hot reload is active: changes to `apps/api/src` restart the API, and changes to `apps/web/src` update live in the browser.

### Isolated ports and environment overrides

Every service binds to `127.0.0.1` only and avoids colliding with an installed operator instance on 4910/4911:

| Service | Default Port | Environment Override |
|---|---|---|
| Web (Vite) | `4921` | `SPACE_WEB_PORT` |
| API Server | `4920` | `SPACE_API_PORT` |
| PostgreSQL | `5433` | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | `7234` | `SPACE_DEV_TEMPORAL_PORT` |
| Compose Project | `spaceapp-dev` | `SPACE_DEV_COMPOSE_PROJECT` |
| State Directory | `.dev-stack/` | `SPACE_DEV_STACK_DIR` |

### Package building & incremental cache

`npm run dev:stack` automatically inspects source modification times (`mtime`) across `packages/*/src` and `apps/*/src` against compiled `dist/` artifacts. Only modified packages are rebuilt on launch.

- **Force rebuild all packages**:
  ```sh
  SPACE_DEV_FORCE_BUILD=true npm run dev:stack
  ```
- **Skip package builds** (e.g. if code was built in another session):
  ```sh
  SPACE_DEV_SKIP_BUILD=true npm run dev:stack
  ```
- **Rebuild an individual package**:
  ```sh
  npm run build -w @space/contracts
  ```

### Platform notes

- **Linux**: Native Docker and Unix domain sockets are used directly.
- **macOS**: Supported using Docker Desktop or Colima (`colima start`).
- **Windows 11 (WSL2)**: Run commands inside a WSL2 Ubuntu terminal with Docker Desktop's WSL2 backend or native Docker installed in WSL2.

### Troubleshooting

- **Port in use**: If any default port (e.g. 5433 or 4920) is occupied on your host, specify an alternate port:
  `SPACE_DEV_POSTGRES_PORT=5434 SPACE_API_PORT=4925 npm run dev:stack`
- **Docker daemon connection**: Verify `docker compose version` works in your shell before launching the stack.
- **Clean reset**: If containers or database states become corrupted, run `npm run dev:stack -- reset` to perform a clean slate reset.

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
