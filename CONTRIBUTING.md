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

Contributors can run the complete SpaceApp stack from source with hot reload using a single command:

```sh
npm run dev:stack
```

### What it starts

In order, `dev:stack`:
1. Launches PostgreSQL (pgvector) and Temporal in Docker containers using the repository's pinned image digests.
2. Applies database migrations (`npm run db:migrate`).
3. Starts the backend API (`apps/api` with hot restart via `tsx watch`), Vite web dev server (`apps/web` with HMR), Temporal worker (`apps/worker`), and CLI host (`packages/cli-host`) from source.
4. Generates an owner setup token and prints the Web UI URL.

### Commands

- **Start**: `npm run dev:stack`
- **Stop**: `npm run dev:stack -- down` (stops supervised processes and Docker containers)
- **Reset**: `npm run dev:stack -- reset` (stops services and removes only the containers, volumes, and `.dev-stack/` state directory created by this command)

### Ports and isolation

To prevent collisions with production or installer SpaceApp instances (which use 4910/4911), `dev:stack` defaults to separate ports bound strictly to `127.0.0.1`:

| Service | Default Port | Environment Variable Override |
| :--- | :--- | :--- |
| Web UI (Vite) | `http://127.0.0.1:5173` | `SPACE_DEV_STACK_WEB_PORT` / `SPACE_WEB_PORT` |
| API Server | `http://127.0.0.1:4920` | `SPACE_DEV_STACK_API_PORT` / `SPACE_API_PORT` |
| PostgreSQL | `127.0.0.1:5433` | `SPACE_DEV_STACK_POSTGRES_PORT` |
| Temporal | `127.0.0.1:7234` | `SPACE_DEV_STACK_TEMPORAL_PORT` |

All state, secrets (mode `0600`), and provider data live in the git-ignored `.dev-stack/` directory.

### CLI panes and OpenCode

The Getting Started room opens with an OpenCode CLI pane. The pinned `opencode-ai` CLI version from `Dockerfile` is automatically installed into `.dev-stack/` (not globally), and wrappers live inside `.dev-stack/bin`. No external AI provider key is required to launch and view the OpenCode terminal interface.

### Platform notes

- **Linux**: Requires Docker with the Compose v2 plugin (`docker compose`).
- **macOS**: Supported with Docker Desktop for Mac or Colima (`colima start`).
- **Windows 11**: Supported via WSL2 (Ubuntu) with the Docker Desktop WSL2 backend enabled. Run `npm run dev:stack` inside your WSL2 terminal.

### Troubleshooting

- **Port collision**: Set `SPACE_DEV_STACK_API_PORT=<port>` or `SPACE_DEV_STACK_WEB_PORT=<port>`.
- **Database or container issues**: Run `npm run dev:stack -- reset` to cleanly wipe state and volumes, then rerun `npm run dev:stack`.
- **Process errors**: If any supervised process exits unexpectedly, the dev stack immediately reports the failing service and terminates safely without silent hangs.

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
