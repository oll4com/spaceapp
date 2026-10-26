<!-- Dragon, 2026-10-26: document the isolated contributor full-stack workflow for issue #65. -->
# Contributor development stack

Use a source checkout you own. This stack creates a separate development
instance with PostgreSQL/pgvector, Temporal, migrations, the source CLI host,
API, Vite and the workflow worker. The application services run from source on
the host; Docker supplies the infrastructure. It never connects to an installed
operator instance or imports a provider account.

## Prerequisites and start

Use Node **>=22.12 <23**, npm, Docker Engine with Docker Compose v2, and a
running Docker daemon accessible to your user. Linux is the reference
environment. On macOS use Docker Desktop; on Windows use a Linux checkout in
WSL2 with Docker available inside that distribution. Native Windows PowerShell
is not supported by this Unix socket/PTY development stack. Keep the checkout
path short: the CLI socket path must fit within 100 bytes.

<!-- Longniang, 2026-10-26: an isolated HOME cannot load a user's Docker Desktop/Colima context metadata. -->
Docker Desktop and Colima commonly use a user-specific Unix socket. The stack
isolates `HOME` and does not copy your Docker configuration. Before starting,
resolve the active local Docker context through Docker's own CLI, pass its
endpoint explicitly, and remove a context override that would take precedence:

```sh
export DOCKER_HOST="$(docker context inspect --format '{{.Endpoints.docker.Host}}')"
unset DOCKER_CONTEXT
npm run dev:stack
```

Keep the same endpoint when running down, reset and rebuild. A standard Linux
Docker Engine listening at `/var/run/docker.sock` needs no endpoint override.
These instructions cover local Unix sockets, not remote TLS credential setup.

The source `node-pty` dependency may need Python 3, Make and a C++ compiler.
Internet access is needed for locked npm dependencies, the pinned infrastructure
images and the exact OpenCode package version declared by the repository
Dockerfile. No provider key or existing login is required to open its terminal
UI. Sending an actual AI task may require a provider connection and is outside
this account-free acceptance check.

<!-- Dragon, 2026-10-26: distinguish stack startup requirements from real-browser and system-tool test dependencies. -->
The development stack itself does not need Chrome, Xvfb or a browser login.
The full repository `npm test` suite also exercises real managed browsers,
media encoding, file search and worker SQLite helpers. On Linux/WSL it requires
Google Chrome executable at `/usr/bin/google-chrome`, Xvfb at `/usr/bin/Xvfb`,
and the `ffmpeg`, `rg` (ripgrep) and `sqlite3` commands on `PATH`. Install these
system dependencies before running the full suite; `npm ci` does not install
them. Some browser fixtures supply an explicit configuration object with the
default Chrome path, so merely setting a different Chrome path in the runner's
environment does not redirect those fixtures. Missing system dependencies are
failed integration checks, not passing evidence for the development stack.

From the checkout root:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
```

Keep this command running. It works without an interactive TTY, so CI can run
it in the background and retain its exit status. Open
[the development web app](http://127.0.0.1:14911), follow owner setup using this
checkout's generated `.dev-stack/secrets/setup-token`, and create your own
development owner password. Open **Getting Started**, add an **OpenCode**
terminal, and wait for the terminal UI. Do not use production credentials here.

The supervisor checks strict dependency readiness rather than treating a
listening API port as success. Logs and isolated state live in `.dev-stack/`;
this generated directory must stay uncommitted. Generated test secrets have
mode `0600` and its private directories have mode `0700`. The Temporal database
configuration is supplied inside its container without making host secrets
world-readable.

## Ports and isolation

| Service | Default loopback port | Override before starting |
| --- | ---: | --- |
| API | 14910 | `SPACE_DEV_API_PORT` |
| Web | 14911 | `SPACE_DEV_WEB_PORT` |
| PostgreSQL | 15432 | `SPACE_DEV_POSTGRES_PORT` |
| Temporal gRPC | 17233 | `SPACE_DEV_TEMPORAL_PORT` |

For example, `SPACE_DEV_WEB_PORT=14912 npm run dev:stack` changes the web
listener. Use the same overrides for start, smoke, rebuild, down and reset:
the ownership manifest checks that they match. Ports must be distinct and in
1024–65535; installed-instance ports 4910/4911 are refused. Docker publishes
infrastructure on `127.0.0.1` only. A checkout-specific Compose project label
keeps its containers and volumes separate from other installations.

## Editing and rebuilding

API source changes are watched by its development process; Vite updates the web
app during editing. Internal workspace packages and the worker are compiled
dependencies, so rebuild them after changing their source:

```sh
node scripts/dev-stack.mjs rebuild
```

This rebuilds workspace dependencies in order and restarts the relevant running
services. A failed build or crashed service fails visibly; a surviving watch
wrapper alone does not establish that the application is healthy.

## Acceptance and lifecycle

For a fresh, disposable stack, run the full-stack check from a second terminal:

```sh
node scripts/dev-stack/smoke.mjs
```

It verifies strict database/worker/CLI-host readiness and serves web HTML, then
claims the owner using only this stack's generated setup token. It generates a
random test email/password in memory, logs out, rejects an unauthenticated room
request and a wrong password, and signs back in through the real login route.
It checks the seeded **Getting Started** room, creates an OpenCode terminal,
allocates the real CLI session, and attaches the authenticated terminal
WebSocket to start the transport and receive printable terminal output.
An allocated session is normally `IDLE` until transport attachment; the check
requires the same session to be active and `RUNNING` after output. It never calls a
development login bypass or submits a model task.

The sanitized `.dev-stack/smoke-proof.json` contains only check outcomes and an
output byte count/hash. It excludes tokens, passwords, cookies and terminal
contents. The smoke creates a disposable owner whose password is intentionally
not retained: reset this test instance before repeating the smoke or doing
interactive owner setup. A JSON proof is evidence of HTTP/protocol acceptance;
it does not certify visual browser layout, successful provider authentication,
AI answer quality or a platform on which it has not actually run.

For a disposable browser check after the smoke, explicitly opt in with
`SPACE_DEV_SMOKE_KEEP_OWNER=1 node scripts/dev-stack/smoke.mjs`. This writes
only the generated fixture email/password into `.dev-stack/test-owner.json`
with mode `0600`; it never stores a cookie, WebSocket ticket or setup token.
Use that synthetic owner for the browser check, then reset the stack. Default
smoke runs keep the password in memory only. Do not upload this fixture file.

```sh
node scripts/dev-stack.mjs down
node scripts/dev-stack.mjs reset
```

`down` stops the owned processes and infrastructure while preserving database
state for another start. `reset` stops the stack and removes its owned volumes,
private state and lock. Reset deliberately destroys this checkout's development
owner and rooms. Neither command is a global Docker prune; resources belonging
to another checkout or application are outside their ownership boundary.

The `Contributor development stack` GitHub workflow runs on Ubuntu with Node
22, starts without a TTY, runs the real owner/terminal check and always resets.
It then verifies that owned containers, volumes, recorded host processes,
private state and supervisor lock are gone, while an unrelated container and
volume remain intact. Its uploaded record is sanitized; service logs and
generated secrets are not uploaded. A green Linux job records Linux acceptance;
WSL2 or macOS acceptance requires its own actual execution and recorded result.

## Troubleshooting

- **Docker or Compose unavailable:** start the daemon and check its access from
  the same Linux/macOS/WSL user running the stack. Do not change socket
  permissions globally or run against another installation.
- **Port occupied:** choose an unused override from the table. The stack fails
  before replacing a process that it does not own.
- **Socket path too long:** move your own checkout to a shorter path, then
  install dependencies there. Avoid deeply nested WSL paths under `/mnt/c`.
- **OpenCode unavailable:** check this stack's logs and network access. Its
  version is read from the existing Dockerfile pin; do not install `latest` or
  copy a binary from an operator instance to hide a version mismatch.
- **Strict readiness fails:** inspect the database, Temporal, worker and CLI
  host logs in `.dev-stack/logs/`. A successful `/readyz` HTTP response without
  `ok: true` is not healthy; use `/readyz?strict=1`.
- **A package edit has no effect:** run the explicit rebuild command above and
  confirm it succeeds. API/web source watch does not compile every internal
  package automatically.
- **Owner already claimed:** preserve your interactive state with `down` and
  sign in with that development owner. To repeat disposable acceptance, use
  `reset` and start afresh. Do not read an operator's saved credentials.
- **Interrupted teardown:** repeat `reset` from the same checkout with the same
  port overrides. Ownership checks fail closed on mismatched or unsafe state;
  do not fix that by deleting another checkout's state or killing arbitrary PIDs.

For the dependency-free provider simulation and contribution gates, return to
[CONTRIBUTING](../CONTRIBUTING.md). That offline simulation and this real
OpenCode UI check answer different acceptance questions.
