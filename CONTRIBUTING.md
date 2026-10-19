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

One command starts a working SpaceApp from this checkout, with hot reload:

```sh
npm run dev:stack
```

It starts, in order: PostgreSQL (`pgvector`) and Temporal in Docker, the
workspace package and worker builds, the database migrations, then the API
(`tsx watch`), the Vite web dev server, the Temporal worker and the CLI host
(`packages/cli-host`) from source. When `/readyz` reports `ok: true` it prints
the URL and the one-time owner setup token. Open the URL, create the owner with
the token and sign in; the Getting Started room opens with an OpenCode pane.
The dev-login shortcut is not used.

```sh
npm run dev:stack -- down
npm run dev:stack -- reset
npm run dev:stack -- status
npm run dev:stack -- rebuild
```

`down` stops a running dev stack from another terminal (`Ctrl-C` in its own
terminal does the same) while keeping its database volume and state. `reset`
removes the containers, volume and state directory created for this stack.
`status` reports whether the supervisor is running and lists its containers.
`rebuild` recompiles all `@space/*` packages and `@space/worker` on demand.

Prerequisites: the Node version above, `npm ci`, Docker with the Compose plugin
(`docker compose version`), Bash, and network access on the first start (to
pull the two Docker images and install `opencode-ai`).

What it creates, and nothing else:

- the Docker Compose project `spaceapp-dev-<hash>` (derived from the state
  directory path, with two containers and one `postgres` volume), using the
  PostgreSQL and Temporal images pinned by digest in
  `packages/run-spaceapp/templates/compose.yml` (read directly from that file);
- the git-ignored state directory `.dev-stack/`: an ownership marker
  (`.spaceapp-dev-stack`), secrets (`postgres-password`, `session-secret`,
  `setup-token`; mode `0600` in a `0700` directory, never printed except the
  one-time setup token), memory, workspaces, the CLI host socket and the CLI
  state. OpenCode is installed there at the version pinned in `Dockerfile`,
  never globally; its provider state and the `opencode-vscode-parity` wrapper
  command live there too. No AI provider account is needed to open the OpenCode
  pane.

It runs beside an installed SpaceApp. Every port binds to `127.0.0.1`:

| Service    | Default | Variable                  |
| ---------- | ------- | ------------------------- |
| Web (Vite) | 4811    | `SPACE_DEV_WEB_PORT`      |
| API        | 4810    | `SPACE_DEV_API_PORT`      |
| PostgreSQL | 54329   | `SPACE_DEV_POSTGRES_PORT` |
| Temporal   | 47233   | `SPACE_DEV_TEMPORAL_PORT` |

`SPACE_DEV_STATE_DIR` and `SPACE_DEV_COMPOSE_PROJECT` select a custom state
directory and Compose project name when running multiple checkouts in parallel.

Hot reload: a change in `apps/api/src` restarts the API (`tsx watch`), a change
in `apps/web/src` hot-reloads in the browser (Vite), a change in
`apps/worker/src` recompiles (`tsc --watch`) and restarts the worker, and a
change in `packages/*/src` automatically rebuilds that package (queuing any
edits that arrive while a build is already running) and restarts the worker
(plus the CLI host when `packages/cli-host` changes). You can also trigger a
full package and worker rebuild manually with `npm run dev:stack -- rebuild`.

If a child process exits unexpectedly, or the worker stops polling Temporal,
the dev stack logs the failing service and exits with a non-zero status. While
running, it polls `/readyz` and logs any readiness degradation and recovery.
The browser service and optional companion services stay disabled.

Platform notes:

- **Linux**: Docker Engine with the Compose plugin, or Docker Desktop.
- **macOS**: Docker Desktop, or Colima (`colima start`, with the `docker` CLI
  and its Compose plugin). Install Node with your usual version manager.
- **Windows 11**: run everything inside WSL2 (Ubuntu), with the checkout in the
  Linux file system (`~/...`, not `/mnt/c/...`). Use Docker Desktop with WSL
  integration enabled for the distribution, or Docker Engine installed in WSL.
  Install Node inside WSL too: the CLI host needs Unix sockets, `0600` POSIX
  file modes and PTYs, so a native Windows shell is not supported. Open the
  printed URL in a Windows browser; WSL forwards `127.0.0.1`.

Example terminal output (Linux and Windows 11 WSL2 Ubuntu):

```text
$ npm run dev:stack
[dev-stack] starting PostgreSQL (pgvector) and Temporal (compose project spaceapp-dev-4b92e1a0c3)
[dev-stack] building workspace packages
[dev-stack] installing opencode-ai@1.18.4 into .dev-stack/cli/vendor/opencode
[dev-stack] running database migrations
[cli-host]     {"service":"@space/cli-host","event":"listening","socketPath":".dev-stack/run/cli-host.sock"}
[worker]       {"service":"@space/worker","event":"worker_state","state":"RUNNING"}
[api]          Server listening at http://127.0.0.1:4810
[web]          VITE ready in 412 ms  ->  http://127.0.0.1:4811/

SpaceApp is running from source.
  Open        http://127.0.0.1:4811
  Setup token <one-time-owner-setup-token>  (one-time: create the owner with it)
  API         http://127.0.0.1:4810   PostgreSQL 127.0.0.1:54329   Temporal 127.0.0.1:47233
  State       /home/contributor/spaceapp/.dev-stack
  Stop with Ctrl-C or npm run dev:stack -- down; remove everything with npm run dev:stack -- reset.
```

Troubleshooting:

- *Port ... is in use*: another process, or a dev stack from another checkout,
  has bound the port. Override the corresponding `SPACE_DEV_*_PORT` variable.
- *Docker with the compose plugin is required*: start Docker Desktop, Colima or
  the Docker daemon, and check `docker compose version`.
- *`docker-credential-desktop.exe: exec format error`* in WSL: the image pull
  goes through Docker Desktop's Windows credential helper. Enable WSL
  integration in Docker Desktop, or remove `credsStore` from
  `~/.docker/config.json` inside WSL; the images are public.
- *The CLI host exits at once, or `node-pty` crashes*: the native module was
  built for another Node binary. Run `npm ci` again with the Node and npm used
  to start the dev stack.
- *The setup token has expired*: it is valid for 15 minutes after the API
  starts. Restart the dev stack, or run `npm run dev:stack -- reset` and start
  again.
- Anything else: run `npm run dev:stack -- reset`, then start again.

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
