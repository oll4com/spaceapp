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

When you need the complete SpaceApp stack (PostgreSQL with `pgvector`, Temporal,
the API in watch mode, the Vite web dev server, the Temporal worker, and the
CLI host with the preconfigured OpenCode CLI) running from your checkout with
hot reload, start the contributor source stack after `npm ci`:

```sh
npm run dev:stack
```

Prerequisites:

- Node **>=22.12 <23** and npm (same as above)
- Docker Engine / Docker Desktop with `docker compose` available (Linux, macOS,
  or Windows 11 with WSL2 integration enabled)

What `npm run dev:stack` does:

1. Reads the digest-pinned PostgreSQL (`pgvector`) and Temporal container images
   from `packages/run-spaceapp/templates/compose.yml` and starts them under the
   isolated `spaceapp-dev` Compose project bound only to `127.0.0.1`.
2. Generates per-checkout secrets and runtime state under `.dev-stack/`
   (git-ignored, `0700`/`0600` permissions) and runs `npm run db:migrate`.
3. Installs the pinned `@opencode/cli` version from `Dockerfile` into
   `.dev-stack/opencode` and writes local CLI wrappers into `.dev-stack/bin` so
   the **Getting Started** room's OpenCode CLI pane reaches `RUNNING` without an
   external AI provider account.
4. Builds workspace packages and supervises `packages/cli-host`, `apps/worker`,
   `apps/api` (`tsx watch`), and `apps/web` (Vite HMR).
5. Prints the Web URL, API URL, and the one-time owner setup token (until owner
   setup is claimed).

Default loopback ports (chosen so `dev:stack` never collides with an installed
`run-spaceapp` instance on `4910`/`4911`):

- Web (Vite dev server): `127.0.0.1:5911` (override with `SPACE_WEB_PORT` or `--web-port`)
- API: `127.0.0.1:5910` (override with `SPACE_API_PORT` or `--api-port`)
- PostgreSQL: `127.0.0.1:55432` (override with `SPACE_DEV_POSTGRES_PORT` or `--postgres-port`)
- Temporal: `127.0.0.1:57233` (override with `SPACE_DEV_TEMPORAL_PORT` or `--temporal-port`)

Stop the stack while keeping your database volume and claimed owner account:

```sh
npm run dev:stack -- down
```

Remove the `spaceapp-dev` containers, volumes, and `.dev-stack/` state directory
to return to a clean first-run state:

```sh
npm run dev:stack -- reset
```

Verify readiness, claim owner setup over HTTP, and verify that the Getting
Started OpenCode CLI pane reaches `RUNNING` without a browser TTY:

```sh
npm run dev:stack:smoke
```

Sample readiness and smoke output:

```text
============================================================
SpaceApp contributor dev stack is ready!
  Web URL:      http://127.0.0.1:5911
  API URL:      http://127.0.0.1:5910
  Readiness:    http://127.0.0.1:5910/readyz
  Setup token:  <one-time-owner-setup-token>
  (One-time owner setup token — enter this at the Web URL to create the owner account)
  Stop stack:   npm run dev:stack -- down
  Reset stack:  npm run dev:stack -- reset
============================================================

{
  "ok": true,
  "readyzOk": true,
  "roomName": "Getting Started",
  "runtimeId": "cli:opencode",
  "status": "RUNNING"
}
```

### Platform notes (Linux, macOS, Windows 11 WSL2)

- **Linux:** Ensure your user can reach the Docker daemon (`docker info`) and
  `docker compose version` succeeds. All ports bind strictly to `127.0.0.1`.
- **macOS (Docker Desktop or Colima):** Start Docker Desktop or Colima
  (`colima start --cpu 4 --memory 8`) before running `npm run dev:stack`. Keep
  the repository inside your macOS user home directory so bind-mounted secret
  files under `.dev-stack/secrets/` are shared into the Linux VM automatically.
  If `node-pty` needs to compile from source, install Xcode Command Line Tools
  (`xcode-select --install`).
- **Windows 11 (WSL2):** Run `npm run dev:stack` inside a WSL2 Linux
  distribution (for example Ubuntu 24.04) with Docker Desktop WSL2 integration
  enabled, and keep the checkout on the Linux ext4 filesystem inside WSL2 (not
  `/mnt/c/`) for fast file watching and Unix domain socket support.

### Troubleshooting

- **Port already in use:** Override any colliding loopback port with
  `SPACE_API_PORT`, `SPACE_WEB_PORT`, `SPACE_DEV_POSTGRES_PORT`, or
  `SPACE_DEV_TEMPORAL_PORT` (or `--api-port`, `--web-port`, `--postgres-port`,
  `--temporal-port`).
- **Docker daemon or container health check failure:** Verify `docker ps` works
  and run `npm run dev:stack -- reset` to recreate the `spaceapp-dev` containers
  and volumes cleanly.
- **Socket path length limit:** The CLI host Unix socket lives at
  `.dev-stack/run/pane-host.sock`. If your checkout path is deeply nested
  (>90 characters), pass `--state-dir /tmp/spaceapp-dev-stack` so the socket
  path stays within the OS `sun_path` limit.

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
