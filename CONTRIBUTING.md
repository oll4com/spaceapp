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

Use Node from `.nvmrc`, npm, a C++ build toolchain/Python for `node-pty`, and a
running Docker daemon with Compose v2 supporting `up --wait`. On macOS use
Docker Desktop or Colima (`colima start`); on Windows 11 run everything inside
WSL2 with Docker Desktop's WSL integration enabled. Native Windows is refused.

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
# In another terminal:
npm run dev:stack -- down
npm run dev:stack -- reset
```

The foreground launcher builds the internal packages and starts PostgreSQL
(pgvector) and Temporal in Docker, then runs migrations and the CLI host,
Temporal worker, API watcher and Vite **from this checkout**. It installs the
exact OpenCode package pinned in `Dockerfile` under `.dev-stack/opencode`,
never globally. First start needs network access for images and that package.

Open the printed URL (`http://127.0.0.1:5911` by default) and use the printed
one-time token to create your owner account. Tokens expire after 15 minutes;
restart the stack if an unclaimed token has expired. Sign in normally and open
an OpenCode terminal in Getting Started; reaching its TUI needs no provider
account. Sending AI requests still requires a working model/provider.
Browser and optional companion services are disabled in this dev stack.

Each checkout has its own Compose project, volume, Unix sockets and ignored
`.dev-stack/` state. Secret files are mode 0600. No installed instance's
credentials, environment configuration or provider homes are reused. All
published ports bind to `127.0.0.1`:

| Service | Default | Override |
| --- | --- | --- |
| API | 5910 | `SPACE_DEV_API_PORT` |
| Vite | 5911 | `SPACE_DEV_WEB_PORT` |
| PostgreSQL | 55432 | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | 57233 | `SPACE_DEV_TEMPORAL_PORT` |

Use distinct free ports and keep the same overrides for `up`, `down` and
`reset`. Ports 4910/4911 are refused to avoid collisions with installed SpaceApp.
Vite fails instead of silently choosing another port. Do not share these
development endpoints through a public proxy.

Edits in `apps/web/src` hot-reload; edits in `apps/api/src` restart the API.
After changes in `packages/*` or the worker, use **one command** in another
terminal: `npm run dev:stack -- rebuild`. It stops the old stack, rebuilds all
internal packages and starts a new foreground stack with the existing data.
Ctrl+C and `down` stop the source process groups and Docker services; `reset`
also removes only this checkout's volume and marked state directory. Unexpected
service exits fail the supervisor and stop the other services.

Troubleshooting:

- `docker info` / `docker compose version` must work before startup. No daemon
  is installed or started for you. On macOS check Colima/Docker Desktop; in WSL2
  check Docker integration and install/build on the Linux filesystem.
- A port conflict: change the corresponding override; do not stop an installed
  SpaceApp to free 4910/4911. A second stack in the same checkout is refused.
- A readiness timeout or failed worker: inspect the named service output;
  authentication shortcuts and disabled workflows are not readiness fixes.
- After an uncatchable supervisor kill, a lock may remain. Inspect its PID and
  confirm no source processes from this checkout are alive before removing
  `.dev-stack/lock`; rerun `reset` to remove its Docker resources. Do not remove
  a lock belonging to a running stack.
- To validate real acceptance in a **fresh checkout without dev state**, run
  `npm run smoke:dev-stack`. It creates an owner, signs in over HTTP, opens and
  attaches a real OpenCode PTY, and asserts that reset leaves no processes,
  containers or volumes. The test creates and destroys only its own data.
  A passing unit test is not evidence of a passing Docker or macOS/WSL2 run.

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
