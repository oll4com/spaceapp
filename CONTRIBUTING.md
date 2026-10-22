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

## Run the full contributor stack from source

To start the complete live stack from this checkout (`PostgreSQL` and `Temporal`
sidecars via Docker Compose, plus `cli-host`, `worker`, `api` and `web` on the
host) with isolated contributor state under `.dev-stack/`:

```sh
npm run dev:stack
```

`npm run dev:stack` requires Docker with `docker compose`. It uses the
SHA256-pinned `postgres` and `temporal` images from
[compose.yml](packages/run-spaceapp/templates/compose.yml) on dedicated
loopback ports (`127.0.0.1:15432` and `127.0.0.1:17233` by default), generates
`0600` secret files under `.dev-stack/secrets/`, installs the Dockerfile-pinned
`opencode-ai` CLI and contributor wrappers into `.dev-stack/bin/`, builds the
internal `@space/*` packages and demo projects in dependency order, runs
`@space/db` migrations, supervises the four host services (`cli-host`,
`worker`, `api`, `web`) with fail-fast exit handling, and waits until
`http://127.0.0.1:4910/readyz` and `http://127.0.0.1:4911/readyz` report
`database`, `worker` and `cliHost` as `RUNNING`. It then prints the web URL
(`http://127.0.0.1:4911`), owner setup URL and bootstrap setup token so you can
claim owner setup and launch the Getting Started OpenCode room immediately.

- **Configurable ports and state directory:** Override the default ports or
  state directory with `SPACE_DEV_POSTGRES_PORT` (`15432`),
  `SPACE_DEV_TEMPORAL_PORT` (`17233`), `SPACE_API_PORT` (`4910`),
  `SPACE_WEB_PORT` (`4911`), and `SPACE_DEV_STACK_STATE_DIR` (`.dev-stack`).
- **Rebuild workspace packages:** Run `node scripts/dev-stack.mjs build-packages`
  to rebuild internal `@space/*` packages and demo projects in topological order.
- **Troubleshooting:** If a supervised host process exits unexpectedly, the
  supervisor stops sibling host processes immediately and prints the failing
  service and exit code; inspect the service output, run `npm run dev:stack:down`
  to clear stale listeners or override conflicting ports via the environment
  variables above, or run `npm run dev:stack:reset` to wipe `.dev-stack/` and
  Docker volumes before restarting.
- **macOS and WSL2 notes:** Ensure Docker Desktop (or the WSL2 Docker engine
  integration) is running so `docker compose` is available. When the checkout
  path makes `.dev-stack/sockets/cli-host.sock` exceed the Unix domain socket
  path limit, `dev-stack` automatically falls back to a short socket path under
  `os.tmpdir()`.

To stop the stack or wipe all contributor state and Docker volumes:

```sh
npm run dev:stack:down
npm run dev:stack:reset
```

To run the contributor stack unit and supervision tests (or opt into the live
Docker + OpenCode end-to-end verification):

```sh
npm run test:dev-stack
SPACE_RUN_DEV_STACK_E2E=1 npm run test:dev-stack
```

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
