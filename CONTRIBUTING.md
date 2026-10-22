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

## Run the full app from source

One command starts everything the installed app runs, from this checkout:

```sh
npm run dev:stack
```

It needs Docker with Compose 2.24 or later (Docker Engine on Linux, Docker
Desktop or Colima on macOS, Docker Engine inside WSL2 or Docker Desktop's WSL2
integration on Windows) and the Node version above. It then:

1. starts PostgreSQL (pgvector) and Temporal in Docker, with the images and
   digests of `packages/run-spaceapp/templates/compose.yml`, published on
   `127.0.0.1` only, and waits for their health checks;
2. installs the OpenCode version the `Dockerfile` pins into
   `.dev-stack/opencode/` (never globally), builds stale internal packages and
   applies the database migrations;
3. runs the CLI host, the Temporal worker, the API (`tsx watch`) and the Vite web
   server from source, and prints the app URL and the one-time setup token once
   `/readyz` is ok.

Open the printed app URL, enter the setup token, create the owner account and
sign in; then open the Getting Started room and add an OpenCode pane. The token
is printed only while no owner exists; later starts say so instead.

| Port | Default | Variable |
| --- | --- | --- |
| Web app (Vite) | 14911 | `SPACEAPP_DEV_WEB_PORT` |
| API | 14910 | `SPACEAPP_DEV_API_PORT` |
| OpenCode server | 14912 | `SPACEAPP_DEV_OPENCODE_PORT` |
| PostgreSQL | 15432 | `SPACEAPP_DEV_POSTGRES_PORT` |
| Temporal | 17233 | `SPACEAPP_DEV_TEMPORAL_PORT` |

The defaults never use 4910/4911, so an installed SpaceApp keeps running beside
it. The containers belong to the compose project `spaceapp-dev-<hash of the
state directory>`, never to the installed app's.

Changes are picked up while it runs: `apps/web/src` through Vite hot reload,
`apps/api/src` by restarting the API, `apps/worker/src` and `packages/*/src` by
rebuilding the package (and the packages that depend on it) and restarting the
processes that load it. If a process exits, `npm run dev:stack` prints which
one and its last log lines, stops the rest and exits with code 1.

```sh
npm run dev:stack -- status
npm run dev:stack -- down
npm run dev:stack -- reset
```

`Ctrl-C` or `down` stops every process and container and keeps the data.
`reset` also removes the database volume and the `.dev-stack/` directory; it
only removes what carries the dev stack's label and project name.

Everything else stays in the git-ignored `.dev-stack/` directory: generated
secrets (mode 0600, never printed except the setup token), `compose.yml`,
logs in `.dev-stack/logs/<process>.log` and the app's data. Other variables:
`SPACEAPP_DEV_STATE_DIR` (another state directory, for a second stack),
`SPACEAPP_DEV_QUIET=1` (no process output in the terminal, logs only) and
`SPACEAPP_DEV_OPTIONAL_MODULES` (default `all`). The dev stack runs OpenCode
only; the browser service and the other CLI runtimes stay with the installed
app.

`node scripts/dev-stack-e2e.mjs` starts a fresh stack and checks all of the
above (owner setup and sign-in, an OpenCode pane, hot reload, a crashed
process, restart, `down` and `reset`); `.github/workflows/dev-stack.yml` runs
it on Linux, macOS (Colima) and Windows (WSL2).

Troubleshooting:

- *Docker is not running* or *Compose is too old*: start Docker Desktop,
  `colima start`, or `sudo service docker start` inside WSL2, and run it again.
- *Port in use*: set the variable from the table to a free port.
- *The database volume exists but its password file is gone*: run
  `npm run dev:stack -- reset` to start over.
- On Windows keep the checkout on the WSL2 file system (`~/...`, not `/mnt/c`),
  where file watching and Unix sockets work. On macOS with Colima, give the VM
  at least 4 GB of memory. node-pty ships its macOS `spawn-helper` without the
  executable bit; the dev stack sets it in `node_modules` (otherwise every pane
  fails with `posix_spawnp failed`).

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
