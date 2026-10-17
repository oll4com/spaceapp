# Contributing to SpaceApp

Advanced API settings are documented in the [configuration reference](docs/configuration-reference.md).

Use a checkout you own. Do not run development tests against an installed
operator instance or reuse its credentials, browser profiles, sockets or data.

## Development prerequisites

The monorepo requires Node **>=22.12 <23**, as declared in the root
`package.json`, and npm. Linux is the reference development environment;
Windows contributors can use WSL. Building `node-pty` may require Python 3,
Make and a C++ compiler if a compatible prebuilt binary is unavailable.
Install `ripgrep` (`rg`) for the source API's file search and its integration
tests (`sudo apt-get install ripgrep` on Ubuntu or `brew install ripgrep` on macOS).

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

After the dependency install above, use Node 22 and a running Docker engine with
Compose v2:

```sh
npm run dev:stack
```

This starts the same digest-pinned pgvector PostgreSQL and Temporal images used
by the launcher, builds this checkout, applies migrations, and starts the API,
Vite, Temporal worker and CLI host. Open the printed loopback URL, enter the
printed one-time setup token, create an owner and sign in. The Getting Started
room includes an OpenCode pane. The Dockerfile's pinned `opencode-ai` version is
installed locally in `.dev-stack/vendor`; reaching its native terminal UI does
not require a provider account. The dev wrapper checks that the CLI starts; it
does not claim a model response or run a provider task.

The default ports are API **54910**, web **54911**, PostgreSQL **55432** and
Temporal **57233**, all on `127.0.0.1`. Before the first start, change them with
`SPACE_DEV_API_PORT`, `SPACE_DEV_WEB_PORT`, `SPACE_DEV_POSTGRES_PORT` and
`SPACE_DEV_TEMPORAL_PORT`. Each must be distinct and cannot be an installed
application's 4910/4911 port. A busy port causes a clear failure. Saved ports
remain attached to that state directory; reset the stack to choose new ones.
Each state directory also sets its own `SPACE_DEV_SESSION_COOKIE_NAMESPACE`,
so signing into another checkout on a different port preserves the first login.

From another terminal in this checkout:

```sh
npm run dev:stack -- down
npm run dev:stack -- reset
```

`down` stops the supervised processes and this compose project while keeping
its database and local state. `reset` also removes this project's volume and
the `.dev-stack` directory, including its development owner, workspace files
and provider state. It refuses an unrecognized directory. Neither command
uses an installed SpaceApp's process IDs, compose project, sockets or volumes.
Ctrl-C also stops the foreground stack. Unexpected service exit is printed
with its service name and stops the stack.
After a hard kill or reboot, `down` checks the recorded process start identity
before treating a live PID as this supervisor. Reused PIDs do not block cleanup
and are never signalled. Legacy records without that identity remain conservative.

The API uses Node watch mode, and Vite reloads web changes. After editing an
internal package, run `npm run dev:stack -- rebuild`; imported build output is
picked up by the running watch processes. Secrets are generated per state
directory with mode 0600. Only the owner setup token is printed, and it expires
15 minutes after API startup. Dev login stays disabled. Browser service, admin
shell and copied-install background jobs stay disabled in this source stack.

On macOS, use Docker Desktop or Colima with the Docker runtime and Compose v2.
The stack repairs the executable bit on node-pty's bundled macOS spawn helper
inside this checkout. The existing Linux `/proc` resource sampler is unavailable
on macOS; its diagnostics do not prevent owner setup or CLI panes.
On Windows 11, run all commands in WSL2 with Docker integration enabled and keep
the checkout in the WSL filesystem. Native Windows is not supported by the Unix
PTY/socket stack. On Linux, use Docker Engine with its Compose plugin. No Docker
image rebuild or paid provider API is required. Keep the checkout path short
enough for a Unix socket (the launcher checks this before starting).

If startup fails, inspect the labelled output (`[api]`, `[worker]`, `[cli]`,
`[web]`, or `[docker]`). Fix the reported build, engine, migration or port error
and start again. An expired unclaimed setup token can be refreshed by stopping
and starting the API/stack. For a disposable clean integration check, use
`node scripts/dev-stack-acceptance.mjs`: it requires a fresh state directory,
performs normal owner setup over HTTP, observes the native OpenCode terminal,
then runs down/reset and verifies that its state, containers, volumes and port
listeners are gone. It never sends an AI prompt. CI runs this check without a TTY.

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
