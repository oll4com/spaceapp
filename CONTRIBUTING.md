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

Use the Node/npm prerequisites above and a working Docker Engine or Docker
Desktop with Compose V2. On macOS, Docker Desktop or an existing Colima context
must already work. On Windows 11, run these commands inside an existing WSL2
Linux environment with Docker integration. The launcher does not install these
tools or change OS settings.

From the checkout root:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
```

The command starts the isolated PostgreSQL/Temporal containers, migrations,
source API, Vite web app, worker and CLI host. Open the printed web URL, create
your local owner with the one-time setup token, then sign in and open Getting
Started and an OpenCode pane. No provider account or API key is needed to reach
the terminal UI. Web changes hot-reload; API changes restart the API; changes
to worker/shared packages rebuild and restart the dependent source services.

Defaults are API `4810`, web `4811`, PostgreSQL `54329` and Temporal `47233`,
all bound to `127.0.0.1`. Use `SPACE_DEV_API_PORT`, `SPACE_DEV_WEB_PORT`,
`SPACE_DEV_POSTGRES_PORT` and `SPACE_DEV_TEMPORAL_PORT` to select unused ports.
Choose `SPACE_DEV_STATE_DIR=.dev-stack-<name>` for a separate instance; the
default is `.dev-stack/`. Installed ports `4910`/`4911` are rejected.

Keep the same state/port environment when stopping or resetting:

```sh
npm run dev:stack -- down
npm run dev:stack -- reset
```

`down` preserves the private database/state; `reset` also removes only that
state and its owned resources. For an occupied port, choose an unused port
before first startup. If Docker is unavailable or cleanup fails, restore the
original Docker context and retry `down` or `reset`; retain the ownership
manifest instead of deleting it. A required process exit is reported by name
and stops the stack. Never share the setup token or generated state directory.

See the [development stack guide](docs/development-stack.md) for alternate-port
examples, private-state details, troubleshooting and the Linux/Intel-macOS proof.

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
