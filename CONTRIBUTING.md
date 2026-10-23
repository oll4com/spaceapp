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
Dependency installation may use the network; the offline smoke command described later does not
need a provider account, API key, Docker, PostgreSQL or Temporal.

## Run the full app from source

Use Node **>=22.12 <23**, npm, Git, ripgrep, SQLite 3, and Docker with Compose v2 or newer.
Docker must be running. On macOS use Docker Desktop or Colima with Docker
Compose installed; on Windows 11 run these commands inside WSL2, with Docker
Desktop's WSL integration enabled. Native Windows is not supported by this
Unix-socket/PTY development command. Keep the checkout in the WSL Linux
filesystem for reliable file watching. Linux needs the usual Python 3, Make
and C++ build tools if `node-pty` has no prebuilt binary for your platform.

After the locked dependency installation above:

```sh
npm run dev:stack
# In another terminal, from this same checkout:
npm run dev:stack -- down
npm run dev:stack -- reset
```

The first start downloads the published pgvector and Temporal images, builds
the internal packages, applies the database migrations, and installs the exact
OpenCode package pinned in `Dockerfile` into `.dev-stack/vendor`. The database
image digests come directly from the published Compose template. It then
starts the API in watch mode, Vite, the worker and the CLI host from this
checkout. The command stays in the foreground and also works without a TTY.
It prints the URL and, until an owner exists, the one-time setup token. Open
the URL, create the owner using that token, then sign in. Getting Started's
OpenCode pane can open its terminal UI without an AI provider account. Sending
a prompt may require a provider account; the dev stack does not supply one.
Provider inference checks are not enabled; terminal availability does not
certify that a model can answer a prompt.
The normal owner flow is used; the dev-login shortcut is disabled.

Default loopback-only ports are:

| Service | Port | Override before first start |
| --- | --- | --- |
| Web UI | 15411 | `SPACE_DEV_WEB_PORT` |
| API | 15410 | `SPACE_DEV_API_PORT` |
| PostgreSQL | 15432 | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | 17233 | `SPACE_DEV_TEMPORAL_PORT` |
| OpenCode server | 15412 | `SPACE_DEV_OPENCODE_PORT` |

For example, `SPACE_DEV_WEB_PORT=16411 npm run dev:stack`. Ports are saved in
the checkout's state; reset before selecting different ports. Every listener
binds to `127.0.0.1`. An installed app on 4910/4911 keeps its own data and
ports. Each checkout gets a distinct Compose project and named database
volume. Passwords, session keys, wrappers, provider homes and logs live in the
git-ignored `.dev-stack/`; secret files have mode 0600. A short, private socket
directory under `/tmp/spaceapp-dev-*` avoids the macOS Unix-socket path limit.
The application and OpenCode receive isolated homes and no inherited provider
keys. Docker alone uses your existing Docker context to reach its daemon.

Changes in `apps/api/src` restart the API, and changes in `apps/web/src` use
Vite hot reload. After changing an internal `packages/*` module or worker
source, run `npm run dev:stack -- rebuild` in another terminal: this rebuilds
the packages and restarts the API, worker and CLI host. Open terminals are
interrupted by that explicit rebuild; reopen the pane afterwards.

`down` (or Ctrl-C) stops the owned processes and removes the project's
containers/network, retaining the database volume and state for next time.
`reset` also removes that project's volume, state and socket directory. These
commands never prune other Docker resources. The browser service, companion
services and root-only features stay disabled. Logs are under
`.dev-stack/logs`; unexpected process exits or prolonged failed readiness
checks stop the stack with a named error. `/readyz` requires the real worker.

If startup fails, inspect the named service log and check `docker compose
version` and `docker info`. A port-in-use error means another checkout or
process uses that port; stop that stack or reset this checkout and choose
different ports. If the owner token expires, stop and start the stack to
refresh its 15-minute setup window. A claimed owner cannot be replaced with
the token; reset deletes this development database if you need a fresh owner.
Use a checkout you own, and never point this command at an operator instance.

The CI acceptance check uses real owner authentication and a WebSocket-backed
OpenCode terminal, then verifies cleanup:

```sh
node scripts/dev-stack-smoke.mjs --report /tmp/spaceapp-dev-proof.json
npm run dev:stack -- reset
node scripts/dev-stack-smoke.mjs --verify-cleanup /tmp/spaceapp-dev-proof.json
```

Run that smoke against a fresh dev stack; it creates a disposable owner. The
report contains resource identities and process IDs, not credentials.

Runtime verification on 2026-10-23 used Node 22.23.4 on macOS arm64 and a
Linux arm64 container with Docker Desktop. Both completed owner setup,
logout/login, real Temporal worker readiness, an OpenCode terminal with output,
normal shutdown and reset cleanup. The macOS run also exercised API/CSS reload,
the rebuild command and intentional worker-exit supervision. The Linux run
verified the configured storage root through the live authenticated admin API.
This is container-based Linux evidence; bare-metal Linux and WSL have not been
verified. No provider inference was requested or tested.

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
