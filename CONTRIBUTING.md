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

## Run the full app from source

Prerequisites: Node >=22.12 <23, npm, Docker with Compose v2, a C++ toolchain,
Python 3 and Bash. Linux is the reference platform. On macOS use Docker
Desktop or Colima; on Windows 11 run inside WSL2 with Docker Desktop's WSL
integration, keeping the checkout on the Linux filesystem. Native Windows
is not supported by this Unix-socket stack.

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
# Open http://127.0.0.1:14911 and claim the owner with the printed setup token.
# Open Getting Started and choose an OpenCode terminal pane.
# From another terminal in this checkout:
npm run dev:stack -- down
npm run dev:stack -- reset
```

The API watches its source and Vite hot reloads web source. After changing any
`packages/*` source or worker code, run **one command**:
`npm run dev:stack -- rebuild`. It stops the old supervisor, rebuilds the
internal packages and worker in dependency order, then starts the stack again.
Keep this supervisor in the foreground; CI may background it with stdin closed.
The browser host, root shells and providers other than OpenCode are not enabled.
Reaching OpenCode's terminal UI requires no provider account; model execution
requires the provider you choose in OpenCode. The stack does not probe an AI
provider during startup.

The state directory defaults to `.dev-stack/` (ignored by Git, directory mode
0700, secrets 0600). Do not share it. The owner setup token is the only printed
secret and expires after 15 minutes; restart before claiming if it expires.
The normal owner-claim and sign-in flow is used, with dev-login disabled and a
separate dev session cookie. Background jobs are disabled by the existing dev
instance policy. The digest-pinned infrastructure images come from the launcher's
Compose template; the OpenCode version comes from the Dockerfile.

| Service | Loopback port | Override |
| --- | --- | --- |
| Web | 14911 | `SPACE_DEV_WEB_PORT` |
| API | 14910 | `SPACE_DEV_API_PORT` |
| PostgreSQL | 15432 | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | 17233 | `SPACE_DEV_TEMPORAL_PORT` |

All listeners bind to 127.0.0.1. Ports must be distinct integers >=1024;
4910/4911 are reserved for installed SpaceApp. Compose project names are derived
from the state directory, so separate checkouts cannot delete each other's
containers or volumes. Use the same port/state environment for up/down/reset.
`down` preserves secrets and database data. `reset` requires an ownership marker
and deletes only that project's resources and its state directory. It never
signals arbitrary PIDs from a file. A missing/stale supervisor control socket
causes an explicit failure instead of risking an unrelated process; after a hard
kill, inspect and stop the owned processes before recovering stale state.

Troubleshooting: start Docker first; inspect `[dev:stack]` service failures rather
than waiting for a silent hang. Resolve port conflicts with the overrides above.
For long socket paths use a short checkout or a private `TMPDIR`. If dependencies
or the pinned OpenCode version change, remove only this stack with `reset`, then
run again. To reproduce the CI end-to-end check, run
`node scripts/dev-stack-smoke.mjs`; it creates a disposable owner, opens a real
OpenCode pane, checks terminal output and verifies reset cleanup. Do not run that
acceptance command against a state directory containing work you want to retain.
