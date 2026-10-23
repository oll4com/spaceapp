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

One command boots the complete stack from this checkout: Postgres and Temporal
in Docker, plus the API, worker and web app as local dev servers with live
reload:

```sh
npm run dev:stack
```

The first run generates `.dev-stack/` (compose file, supervisor state and
generated secrets). It is git-ignored and holds real credentials; never commit
it. Stop the stack and tear down the containers, then wipe all local dev-stack
state and volumes:

```sh
npm run dev:stack -- down
npm run dev:stack -- reset
```

`reset` deletes the Postgres and Temporal volumes, so it is the fix when the
local database is in a bad state.

### Prerequisites

- Docker (the daemon must be running).
- Node **>=22.12 <23**, as declared in the root `package.json`.
- Free loopback ports (defaults below).

### Default ports

Everything binds to `127.0.0.1`. Each port can be overridden with an
environment variable:

| Service  | Default | Host -> container | Env override                  |
|----------|---------|-------------------|-------------------------------|
| API      | 4912    | -                 | `SPACE_DEV_STACK_API_PORT`    |
| Web      | 4913    | -                 | `SPACE_DEV_STACK_WEB_PORT`    |
| Postgres | 5433    | 5432              | `SPACE_DEV_STACK_POSTGRES_PORT` |
| Temporal | 7234    | 7233              | `SPACE_DEV_STACK_TEMPORAL_PORT` |

The web dev server proxies `/api`, `/plugins`, `/healthz`, `/readyz` and
`/version` to the API port from `SPACE_API_PORT` (default `4910` when you run
`npm run dev:web` on its own).

### Hot reload

- Changes under `apps/web/` reload in the browser through Vite HMR.
- Changes under `apps/api/src/` or `apps/worker/` restart the local server
  through `tsx watch`.
- After changing `packages/*`, rebuild the affected package, e.g.
  `npm run build -w @space/contracts`, then restart the stack
  (`npm run dev:stack -- down` and `npm run dev:stack` again) so the API and
  worker pick up the built output.

### Troubleshooting

- **Port already in use**: `npm run dev:stack` fails to start. Find the
  listener (`ss -ltnp | grep <port>` on Linux, `lsof -i :<port>` on macOS) and
  stop it, or set the matching `SPACE_DEV_STACK_*_PORT` variable.
- **Docker is not running**: the stack cannot create the Postgres and
  Temporal containers. Start the Docker daemon (or Docker Desktop / Colima)
  and run the command again.
- **Stuck database or half-created state**: `npm run dev:stack -- reset`
  removes the `.dev-stack/` directory contents and the dev-stack volumes.
- **Logs**: the stack streams the API, worker and web logs to the terminal.
  In CI the same output is captured to `dev-stack.log`.

### macOS

Use Docker Desktop or Colima. With Colima, start it with enough memory before
the stack (`colima start --memory 8`); the default profile is usually fine
otherwise.

### Windows 11

Run everything inside WSL2: install Docker Desktop with the WSL2 backend (or
Docker inside the WSL2 distribution), Node 22 in WSL2, and run `npm ci` and
`npm run dev:stack` from the WSL2 shell, not from PowerShell. Keep the checkout
on the Linux filesystem (`~/...`) rather than under `/mnt/c` for acceptable
file-watch performance.

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
