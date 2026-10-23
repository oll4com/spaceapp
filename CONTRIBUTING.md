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

## Run the complete app from source

With Docker Engine or Docker Desktop available, start the contributor stack:

```sh
npm run dev:stack
```

The command starts digest-pinned PostgreSQL with pgvector and Temporal in an
isolated Compose project, builds the workspace before migrations on a fresh
checkout, installs the `opencode-ai` version pinned by `Dockerfile` into local
state, and launches the CLI host, worker, API and Vite web server from this
checkout. The API uses normal single-owner setup: `SPACE_DEV_LOGIN` stays off.
When `/readyz` reports the database, worker and CLI host as running, the command
prints the local Web URL. It queries the API's owner setup status and prints the
one-time setup token **only** if an owner has not been claimed and that token is
still valid. On an ordinary restart after owner creation, it prints a sign-in
instruction instead; an expired or unavailable setup token is not displayed.
If the API setup status cannot be verified, startup fails rather than logging a
possibly consumed token. Do not use `reset` merely to recover a setup token:
`reset` deletes this checkout's persistent dev data.

The default source-stack ports are deliberately separate from an installed
SpaceApp: API `5910`, Web `5911`, PostgreSQL `55432`, and Temporal `57233`.
Docker-published ports bind to `127.0.0.1`. Runtime state and generated secrets
live under the git-ignored `.dev-stack/`; secret files are mode `0600`. Provider
API keys and GitHub tokens inherited by the shell are not passed to source
services.

Useful lifecycle commands are:

```sh
npm run dev:stack -- status
npm run dev:stack -- rebuild
npm run dev:stack -- down
npm run dev:stack -- reset
```

`rebuild` rebuilds workspace packages and restarts the source services under the
same supervisor. `down` stops only this checkout's supervised processes and
Compose project. `reset` additionally removes this checkout's Compose volumes
and state directory; if Docker cannot remove an owned volume, reset fails and
keeps the state needed to retry cleanup instead of reporting success. Lifecycle
commands verify the recorded supervisor start identity and checkout hash before
sending a signal, so a stale PID file cannot target a reused unrelated PID.

The isolated ports can be overridden with `SPACE_DEV_API_PORT`,
`SPACE_DEV_WEB_PORT`, `SPACE_DEV_POSTGRES_PORT`, and
`SPACE_DEV_TEMPORAL_PORT`. The state directory and Compose project identity are
derived from this checkout and intentionally cannot be overridden, so lifecycle
commands cannot target another checkout's resources. The runner also rejects
installed-instance ports `4910` and `4911`, duplicate ports, unsafe state roots,
and symlink state roots.

For an automated end-to-end proof after the stack is ready, run:

```sh
npm run verify:dev-stack
```

That proof performs normal owner setup, points the Getting Started room at the
current checkout rather than `/opt/spaceapp`, starts its OpenCode terminal pane
through the real CLI host, attaches the same terminal WebSocket transport used
by the web UI, requires a running CLI session plus real terminal output, and
verifies that the stack remains ready. The dedicated GitHub Actions workflow
runs this lifecycle on Linux and on an Intel macOS runner using Colima. Windows
11 contributors should use WSL2 with Docker Desktop's WSL integration or a
Docker engine running inside WSL2; that path follows the Linux host model.
These host paths are contributor environments, not installer-release
certification.

The Linux lifecycle job also edits and restores source files in its disposable
checkout: it checks API watch restarts, imports a rebuilt package marker through
the running API, and verifies Vite updates a real Chrome page without navigation
or losing form state. It then stops the owned worker, requires a clear failure
and nonzero supervisor exit, and exercises an explicit normal restart with the
same owner data. These mutation probes are CI-only and are not needed for normal
contributor startup. Their screenshots include only the anonymous login heading;
state directories, credentials, browser profiles and source backups are not
uploaded. The final cleanup restores original source bytes and checks owned
processes, containers, volumes, networks, state and the Unix socket are gone.

### Troubleshooting the source stack

- If Docker is unavailable, run `docker compose version` first and start Docker
  Desktop, Colima, or the Docker daemon before `npm run dev:stack`.
- If a default dev port is occupied, set the corresponding
  `SPACE_DEV_*_PORT` variable rather than reusing installed ports `4910/4911`.
- If a package change is not reflected in a running source service, run
  `npm run dev:stack -- rebuild`; Vite handles `apps/web/src` edits directly
  and the API runs under `tsx watch`.
- If startup is interrupted, `npm run dev:stack -- down` stops the owned
  supervisor and Compose project. Use `npm run dev:stack -- reset` for a clean
  database and state directory; a failed volume removal is reported and leaves
  the state in place so cleanup can be retried safely.
- On macOS, `npm run dev:stack` repairs the execute bits on node-pty's published
  `prebuilds/darwin-*/spawn-helper` before the CLI host starts. If you launch
  the CLI host outside this workflow and a terminal remains `IDLE` with an
  `EACCES` spawn error, repair that helper's execute permission first.
- Unix socket paths are automatically shortened under the system temporary
  directory when `.dev-stack` would exceed the platform socket-path limit.

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
