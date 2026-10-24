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

One command starts the whole application from a fresh clone — no image
builds, no manual service wiring:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci   # once, if node_modules is missing
npm run dev:stack                        # start everything
npm run dev:stack -- down                # stop processes and Docker services
npm run dev:stack -- reset               # stop + remove containers, volumes and state
```

**Prerequisites.** Node >=22.12 <23 and npm (as above), plus a running
Docker with Compose v2 — only PostgreSQL (pgvector) and Temporal run in
Docker, using the same digest-pinned images as
`packages/run-spaceapp/templates/compose.yml` (the digests are read from
that file at startup, never copied). The API (watch mode), the Vite web dev
server, the Temporal worker and the CLI host all run from source.

**What it does.** The command creates a `.dev-stack/` state directory
(git-ignored) holding per-install secrets (mode 0600), the rendered compose
file, logs, the CLI provider state, the `*-vscode-parity` wrapper commands
and the pinned OpenCode build from the `Dockerfile`, installed into the
state directory rather than globally. It runs the migrations, starts the
processes in dependency order and waits until `/readyz` reports `ok: true`
with workflows enabled. It then prints the web URL and the one-time owner
setup token — complete the usual owner setup in the browser (setup token →
create owner → sign in; the token is valid for about 15 minutes after the
API starts, restart the stack if it lapses). The dev-login shortcut is
never enabled. If any process exits, the command says which one and where
its log is instead of hanging silently.

**Ports.** Everything binds to `127.0.0.1` only, on its own ports so an
installed SpaceApp on 4910/4911 is never touched: web 14911, API 14910,
PostgreSQL 15432, Temporal 7233. Override any of them with
`SPACE_DEV_WEB_PORT`, `SPACE_DEV_API_PORT`, `SPACE_DEV_POSTGRES_PORT` and
`SPACE_DEV_TEMPORAL_PORT`.

**Hot reload.** Editing `apps/api/src` restarts the API, editing
`apps/web/src` hot-reloads in the browser, and editing `packages/*` or the
worker rebuilds that package and restarts the processes that consume it.

**Platform notes.** Linux works as-is. On macOS, Docker Desktop or Colima
both work (`colima start` before the command). On Windows 11, run
everything inside WSL2, including Docker Desktop's WSL2 backend; the
commands above are run from the WSL2 shell, not from PowerShell.

**Troubleshooting.** "Docker is not reachable" — start Docker Desktop /
Colima / dockerd and retry. A port is already in use — another dev stack or
an unrelated process holds it; pick another port with the variables above.
The setup token expired — stop and start again, then claim promptly. Logs
for every process are in `.dev-stack/logs/`. `npm run dev:stack -- status`
shows what is currently running; `reset` returns the machine to a clean
slate.

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
