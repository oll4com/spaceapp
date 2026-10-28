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

## Run the full app from source

After `npm ci`, start the source application with:

```sh
npm run dev:stack
```

Use Node 22.12–22.x, Python 3 (also used for the OS-held checkout lock), a C/C++ build toolchain (for `node-pty`), and Docker with Compose v2 or newer. On Linux, start
Docker Engine first; on Ubuntu, install `build-essential` and `python3` before
`npm ci`. On macOS, the Xcode Command Line Tools provide the compiler. On macOS, start Docker Desktop or Colima (`colima start`).
On Windows, use WSL2 with Docker Desktop's WSL integration. Run the commands
inside the Linux checkout; native Windows is not supported by the Unix PTY host.
Initial startup downloads PostgreSQL/pgvector, Temporal and the pinned OpenCode
CLI, so network access is required. No AI provider account is needed to open
its terminal UI.

The foreground command starts its own Compose project, waits for both database
services, builds the internal packages and worker, applies migrations, then
starts the API watcher, Vite, worker and source-built CLI host. It prints
`http://127.0.0.1:14911` and a one-time owner setup token. Open the URL, enter the
token, create the owner account, and sign in with its password. The Getting
Started room includes an OpenCode terminal. Sending a model request follows
OpenCode's provider configuration and is separate from opening the UI.

API edits restart through `tsx watch`; web edits use Vite HMR. After changing
an internal package, the worker or CLI host, run this in another terminal:

```sh
npm run dev:stack -- rebuild
```

This rebuilds internal packages and restarts the worker and CLI host; open PTY
sessions end during that restart. The API watcher reloads changed dependencies.
A required process exiting stops the stack with its name and a nonzero status.
Ctrl-C and `down` stop the processes and containers, preserving development data:

```sh
npm run dev:stack -- down
npm run dev:stack -- reset
```

`reset` additionally removes this checkout's Compose containers, database
volume, network, short temporary socket directory, and `.dev-stack/`. It refuses
unmarked, moved, or symlinked state. Keep the checkout at its original path until
you reset. Only the project's own resources are managed; the published
`run-spaceapp` installation is independent.
The ignored, empty `.dev-stack.lock` file stays in place so concurrent commands
always lock the same inode. Do not delete or replace it while commands run.

All five listeners bind to `127.0.0.1`. To change ports, set these variables on
the **first** start (reset before changing an existing stack's ports):

| Variable | Default |
| --- | ---: |
| `SPACE_DEV_API_PORT` | 14910 |
| `SPACE_DEV_WEB_PORT` | 14911 |
| `SPACE_DEV_POSTGRES_PORT` | 15432 |
| `SPACE_DEV_TEMPORAL_PORT` | 17233 |
| `SPACE_DEV_OPENCODE_PORT` | 14747 |

The launcher reads image digests from the installer's Compose template and the
OpenCode version from `Dockerfile`. `.dev-stack/` is ignored; it holds generated
0600 secrets, the private Compose configuration, isolated provider home and
CLI install. It does not import installed-instance credentials or enable dev
login. Only the setup token is printed. Background operator jobs and host analytics, root panes,
browser hosts and optional companions are disabled in this development instance.

For repeatable Linux/macOS acceptance on a fresh stack:

```sh
npm run test:dev-stack
npm run smoke:stack
```

The smoke starts without a TTY, checks worker/database readiness, creates and
signs in the owner, opens the real OpenCode pane through the API and WebSocket,
then stops and resets. It verifies ports, containers, volumes, network and state
were removed. It refuses to overwrite existing development state. Use `npm run smoke:stack -- --rebuild --worker-exit` to also check internal package rebuild/restart and that an unexpected
worker exit stops the supervisor with status 1. The Contributor stack workflow
runs the acceptance check on Ubuntu.

If startup reports a Docker connection error, start your Docker engine and run
`docker info` before retrying. A port conflict names the occupied
port; choose a free `SPACE_DEV_*_PORT` before the first start. If `npm ci` cannot
build `node-pty`, install the platform compiler and Python prerequisites above.
Ctrl-C also cancels builds, installs and Docker startup; cleanup then stops the
owned containers. After a crash or reboot the OS releases the checkout lock.
Retry `down` or `reset`; a later `up` restores a missing temporary socket directory
without changing secrets. If a forced kill left app processes alive, stop those
known processes before restarting; port preflight will refuse a second stack.
For a legacy `running/pid` marker, automatic recovery requires a confirmed dead
PID under the checkout lock. A live/reused PID, permission error, or missing or
invalid PID refuses recovery and never triggers a process kill. After verifying
all old stack processes are stopped, move that legacy `running` directory aside
and retry. An older incomplete `.dev-stack` without `owner.json` also requires
inspection and moving aside; ownership cannot safely be inferred. New state is
published only after initialization completes. A forced kill during initialization
may leave an ignored `.dev-stack-init-*` staging directory; it does not block
startup and can be removed after confirming no command is initializing it.

## Reviews and payment

Pull requests are reviewed and merged by the maintainers named in the public repository's `MAINTAINERS`
file. A merged pull request stays in every later release with its author.

Contributions are voluntary; payment applies only to issues labelled 💎 Bounty, under the terms posted on
that issue.
