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

One command starts the whole stack from a clean checkout:

```sh
npm run dev:stack
```

It starts PostgreSQL (pgvector) and Temporal in Docker, runs the migrations,
then starts the API in watch mode, the Vite web dev server, the Temporal worker
and the CLI host from source. It prints the URL and a one-time owner setup
token, and keeps running until you stop it.

```sh
npm run dev:stack            # start, print the URL and the setup token
npm run dev:stack -- down    # stop every process and container it started
npm run dev:stack -- reset   # down, then delete what it created
npm run dev:stack -- status  # show what is running
```

Open the printed URL, choose **owner setup**, paste the token, create the owner,
sign in, open the Getting Started room and start an OpenCode pane. The stack
uses the normal setup-token → create owner → sign-in flow; the dev-login
shortcut is not enabled.

### Prerequisites

| | |
|---|---|
| Node | **>=22.12 <23** (`.nvmrc` pins 22.23.0) |
| npm | bundled with Node |
| Docker | with the compose plugin — Docker Desktop, Colima, or the docker engine |
| Build toolchain | Python 3, Make and a C++ compiler for `node-pty` if no prebuilt binary is available |

Run `npm run build` first if `packages/db` and `packages/cli-host` are not built;
the stack starts their `dist` output.

### Ports

The dev stack uses ports next to an installed SpaceApp so the two can run side
by side. Everything binds **127.0.0.1 only**, including PostgreSQL and Temporal.
Every port is overridable.

| Service | Default | Override |
|---|---|---|
| API | 5910 | `SPACE_DEV_STACK_API_PORT` |
| Web (Vite) | 5911 | `SPACE_DEV_STACK_WEB_PORT` |
| PostgreSQL | 55432 | `SPACE_DEV_STACK_POSTGRES_PORT` |
| Temporal | 57233 | `SPACE_DEV_STACK_TEMPORAL_PORT` |
| Temporal UI | 58080 | `SPACE_DEV_STACK_TEMPORAL_UI_PORT` |

An installed SpaceApp owns 4910 (API) and 4911 (web); the dev stack never uses
those.

### Isolation

The dev stack is deliberately separate from an installed SpaceApp:

- its own `docker compose` project name (`spaceapp-dev-stack`), so its containers
  and volumes are findable and removable by label
- its own state directory (`.dev-stack/`, git-ignored) for secrets, logs, the
  CLI host socket, provider state, memory, artifacts and workspaces
- ports that do not collide with 4910/4911
- generated secrets (database password, session secret, setup token) are per
  state directory, written with mode 0600, never printed apart from the setup
  token, and never committed
- `npm run dev:stack -- reset` removes only what this command created — the
  compose project's containers and volumes, and `.dev-stack/` — then verifies
  that nothing is left behind

The Docker images are pinned by digest and **read from
`packages/run-spaceapp/templates/compose.yml`** at run time. They are not copied
into the dev stack, so the two cannot drift.

### Hot reload

| Where you edit | What happens |
|---|---|
| `apps/api/src` | the API restarts (`tsx watch`) |
| `apps/web/src` | the Vite dev server hot-reloads the page |
| `packages/*` | rebuild with `npm run build -w <package>`; the running process picks it up on restart |

### Troubleshooting

| Symptom | Fix |
|---|---|
| `Docker with the compose plugin is required` | Install and start Docker Desktop, Colima or the docker engine, then re-run. |
| `Could not find a digest-pinned ... image` | `packages/run-spaceapp/templates/compose.yml` lost its digest pins. Restore them; the stack refuses to guess a tag. |
| `Migrations failed` | `npm run build -w @space/db`, then re-run. |
| A service exited unexpectedly | `dev-stack` prints the log path (`.dev-stack/logs/<name>.log`) and shuts the whole stack down so nothing is left half-running. |
| `readyz` never reports `ok: true` | Check `.dev-stack/logs/api.log`; the API prints the failing dependency there. |
| Ports already in use | Set the matching `SPACE_DEV_STACK_*_PORT` override. |
| Stale containers after a crash | `npm run dev:stack -- reset` — it removes only its own project. |

### Platform notes

**macOS** — Docker Desktop or Colima both work. Colima:

```sh
colima start --cpu 4 --memory 8
npm run dev:stack
```

The dev stack looks for `docker` on `PATH`; it does not start a runtime for you.

**Windows 11** — run inside **WSL2**, not PowerShell. Docker Desktop with the
WSL2 backend works. Inside WSL2 the workflow is identical to Linux. On Windows
the POSIX `0600` mode assertion on the generated secrets is skipped (the
filesystem has no POSIX permission bits); the state directory sits under the
per-user profile instead.

**Linux** — the reference environment. `docker` plus the compose plugin is
enough; no Docker Desktop required.

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
