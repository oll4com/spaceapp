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

`dev:api` gives you the API alone (a throwaway in-memory instance with a
dev login). When you need the **whole product** — real PostgreSQL storage,
Temporal workflows, the worker, and CLI panes — from a plain checkout, use
the dev stack:

```bash
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci   # once
npm run dev:stack                        # one command, everything
```

Prerequisites: Node.js per `.nvmrc`, and a Docker engine — Docker Desktop,
Colima (`brew install colima docker docker-compose && colima start`) or a
Linux Docker daemon. Nothing else is installed globally: the stack even
keeps its OpenCode binary inside its own state directory.

The command starts, in order: PostgreSQL (pgvector) and Temporal in Docker
— the exact digest-pinned images from
`packages/run-spaceapp/templates/compose.yml`, parsed at runtime, never
copied — then a dedicated Temporal namespace, the package builds, database
migrations, the API (watch mode), the Vite web dev server, the Temporal
worker and the CLI host from `packages/cli-host`, all from source. When
`/readyz` reports `ok: true` it prints the URL and a **one-time owner
setup token**: open the URL, choose owner setup, paste the token, create
the owner account, sign in, open the Getting Started room, and start an
OpenCode pane — the pane runs through the from-source CLI host and needs
no AI provider account to open its terminal UI. (The token can be claimed
for 15 minutes after the API starts; restarting the stack opens a fresh
window. The stack never uses the dev-login shortcut.)

Isolation: the dev stack is a separate *dev instance*. It has its own
Compose project (`spaceapp-dev-stack`), its own database, Temporal
namespace and task queue, its own CLI host socket, and all of its state —
secrets, logs, the OpenCode install, wrapper commands, provider state —
under `.dev-stack/` (git-ignored). It never touches an installed SpaceApp
or its data. Every port binds to `127.0.0.1` only:

| Service  | Default port | Override             |
| -------- | ------------ | -------------------- |
| Web (Vite) | 5911       | `SPACE_DEV_WEB_PORT` |
| API      | 5910         | `SPACE_DEV_API_PORT` |
| PostgreSQL | 55432      | `SPACE_DEV_POSTGRES_PORT` |
| Temporal | 57233        | `SPACE_DEV_TEMPORAL_PORT` |

(4910/4911 are refused: those belong to an install.) Secrets are generated
per state directory with `0600` permissions and never printed — the setup
token is the one exception, since it is the claim credential. The database
password is handed to the two containers through the Compose process
environment, read from that `0600` file by the stack script itself: a
bind-mounted secret file would keep the host's `0600` mode inside the
container, which the Temporal image's non-root user cannot read. Later starts
reuse the same secrets and data; `Ctrl-C`, or from another terminal:

```bash
npm run dev:stack -- down     # stop everything the stack started
npm run dev:stack -- reset    # …and remove only what it created
npm run dev:stack -- status   # what is running right now
```

`reset` removes the stack's containers, its volumes and the whole
`.dev-stack/` directory, then verifies nothing from the stack is left.
Anything else on the machine — including an installed SpaceApp and its
Docker data — is untouched.

Hot reload: edits under `apps/api/src` restart the API (tsx watch); edits
under `apps/web/src` hot-reload in the browser (Vite). Edits under
`packages/*` rebuild that package and restart the worker, the CLI host and
the API so the change is picked up. If a stack process dies, the command
fails loudly — it names the process and its log under `.dev-stack/logs/`
and shuts the stack down, instead of hanging silently.

Platforms:

- **macOS** — works with Docker Desktop or Colima (commands above). The
  first Colima start takes a few minutes; give the VM at least 6 GB if
  Temporal feels slow (`colima start --memory 6`).
- **Windows 11** — run everything inside WSL2: install Docker Desktop
  with the WSL2 backend (or a Docker engine inside the distro), clone the
  repository into the WSL2 filesystem (not `/mnt/c` — socket paths and
  file watching misbehave across the boundary), and use the exact Linux
  commands above.

Troubleshooting:

- *Docker did not answer* — start Docker Desktop / Colima / the daemon;
  the command says so and exits before changing anything.
- *Port already in use* — the message names the variable (for example
  `SPACE_DEV_API_PORT=6010 npm run dev:stack`) to move just that service.
- *Setup token expired* — claiming is a 15-minute window from API start;
  restart the stack and claim promptly.
- *API exits on macOS with `EACCES ... mkdir '/opt/spaceapp'`* — that is
  the installed layout's default data root; a source checkout cannot
  write there. The dev stack already redirects every such root into
  `.dev-stack/`; if you see this you are starting the API some other way.
- *A pane stays IDLE on macOS and never starts* — node-pty's published
  macOS prebuild ships its `spawn-helper` without the execute bit, so
  every PTY spawn fails. The dev stack repairs the bit inside
  `node_modules` on startup; if you spawn the CLI host some other way,
  `chmod +x node_modules/node-pty/prebuilds/darwin-*/spawn-helper`.
- *Something is wedged* — `npm run dev:stack -- reset`, then start again.
  The state directory is disposable by design; exports from a real install
  are never stored there.

CI runs this end to end on Linux and macOS (`.github/workflows/dev-stack.yml`):
it starts the stack without a TTY, completes owner setup over HTTP, opens
an OpenCode pane through the API, checks the pane is running, resets, and
verifies no container, volume or process is left.

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
