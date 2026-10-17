# Source development stack

`npm run dev:stack` runs a contributor checkout with the real source API, Vite
web app, Temporal worker and CLI host. PostgreSQL/pgvector and Temporal run in
Docker; their image digests come from the installer’s canonical Compose template.
OpenCode’s version comes from the root Dockerfile. This is a development launcher,
not an installed operator instance or a desktop packaging command.

## Prerequisites and startup

Use Node22 from `.nvmrc`, npm, Docker Engine/Desktop with ComposeV2, and the normal
native build tools for `node-pty` if its prebuilt package is unavailable. On macOS,
an existing Docker Desktop or Colima context must already work. On Windows11 use
an existing WSL2 Linux environment with Docker integration; native Windows is not
a Unix-socket runtime. The launcher never installs Docker/WSL, requests elevation,
changes OS features or reboots. WSL2 instructions describe the supported route;
the hosted platform proof below targets Linux and Intel macOS.

From this checkout’s root:

```sh
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
npm run dev:stack
```

Startup checks all requested ports, creates private state, starts the two pinned
containers, builds the workspace, installs the pinned OpenCode package under that
state, applies database migrations and starts the four source services. It prints
the web/API URLs and the one-time owner setup token. Open the web URL, claim the
owner with that token and your own new local credentials, then sign in through
the normal owner flow. After setup, create/open the Getting Started room and an
OpenCode terminal pane. No development-login bypass is enabled.

This OpenCode wrapper opens its actual terminal UI with an empty private provider
profile. It does not copy an operator’s credentials or perform the production
first-launch model smoke test. Authentication/inference commands are blocked;
the acceptance proof sends no model prompt and needs no provider API key/account.
Other provider wrappers, companion services, root CLI/file administration,
background integrations and optional modules are disabled in this isolated stack.
DOCX conversion never falls back to the installed privileged normalizer in dev;
it requires an explicitly configured direct LibreOffice command and private work
directory. The launcher does not install that optional tool.

Changes in `apps/api/src` restart the API. Worker or shared-package source changes
stop the dependent source services, run the normal complete build, and restart
them from this checkout. Vite handles web HMR directly, including WebSocket proxying
to the chosen API port. A required child exiting unexpectedly produces a named
error and stops the stack. Sustained readiness loss also fails instead of leaving
an apparently healthy partial stack.
On failure, bounded logs and health-probe output from owned containers are redacted
before cleanup. This capture does not expose container environments and a failed
diagnostic cannot skip the normal ownership checks or cleanup.

## State, ports and privacy

Defaults are API4810, web4811, PostgreSQL54329 and Temporal47233. All listeners bind
to127.0.0.1. Installed defaults4910/4911 are rejected. To run a second checkout or
separate instance, choose four distinct unused ports and a different direct child
state directory:

```sh
export SPACE_DEV_STATE_DIR=.dev-stack-alternate
export SPACE_DEV_API_PORT=5810 SPACE_DEV_WEB_PORT=5811
export SPACE_DEV_POSTGRES_PORT=55439 SPACE_DEV_TEMPORAL_PORT=57233
npm run dev:stack
```

The same state preserves its ports and database across restarts. It gets a random
Compose project and ownership nonce, separate database/Temporal namespace/task
queue, Unix socket, writable directories and CLI/provider homes. Plugin configuration,
personal Git credential storage, OAuth settings and diagnostic history stay under
that private install root. The canonical dev-instance job policy disables plugin
skill-link synchronization, including connect/disconnect calls. The subprocess
environment is allowlisted; inherited provider keys, session secrets, operator
homes and SSH agents are not forwarded to application children. Docker control
connectivity still uses your selected Docker context, including the normal Docker
configuration/agent if that context requires it.

Generated state defaults to `.dev-stack/` and is ignored by Git. Only recognizable
direct children `.dev-stack` or `.dev-stack-<name>` are allowed; linked state/control
paths are rejected. The state directory is0700 and generated secrets/manifests/
Compose configuration are0600. The PostgreSQL password is in the private generated
Compose file as container environment, avoiding weaker world-readable bind-mounted
secrets. A Docker administrator can inspect container environment; this does not
isolate a secret from the host/Docker administrator. Never print `docker compose
config`, upload the state directory, or share the setup token. CI suppresses the
token; subprocess logs redact generated secrets, including split output chunks.

## Stop, reset and recover

Keep the same `SPACE_DEV_STATE_DIR` selection in the shell:

```sh
npm run dev:stack -- down
npm run dev:stack -- reset
```

Ctrl-C and `down` stop only the tracked process tree and that state’s containers/
network; they retain database/state for reuse. `reset` additionally removes that
state’s labeled volume and private directory. Neither runs prune, broad process
name matching, port-based kills, installer uninstall or operator cleanup. Process
identities are checked again before signals, and every project resource must have
the matching generated ownership label. A foreign resource, unavailable daemon
or failed process/container removal fails the command and keeps recovery state.
Restore the original Docker context and retry `down`/`reset`; do not delete the
manifest as a shortcut. Stop the supervisor before manually repairing owned state.
Linux records include the kernel boot ID as well as process start ticks. A legacy
ticks-only record is refused and recovery state is kept; it is never guessed or
upgraded into permission to signal a process. Stop that stack with its original
launcher before changing versions, or independently resolve its old process state.

## Reproducible complete proof

`npm run test:dev-stack` runs daemon-free regressions for ownership, private paths,
permissions, pins, environment isolation, redaction, PID reuse and failed commands.
These tests do not establish a working Docker stack or browser.

`.github/workflows/dev-stack.yml` prepares only standard public `ubuntu-latest`
and `macos-15-intel` runners and checks the exact source. Both run all 62 launcher
regressions, `npm run check`, `npm run build` and `npm run hygiene:preflight`.
Ubuntu also runs the full unmodified `npm test` suite. Native macOS runs all 13
private-instance API regressions in the four `instance-storage`/`dev-*-storage`
and `dev-docx-isolation` test files, followed by the same complete real-stack proof.
macOS also runs the CLI-host regressions, including its native `/bin/stty` selection;
Linux keeps the existing `/usr/bin/stty` command.
The broader native-macOS stock suites retain upstream limitations, including the
Linux-only descriptor filesystem backend and `/proc` metadata helper; those suites
are not claimed to pass on macOS. Their assertions and the Linux full-suite gate
remain unchanged.
The macOS job uses an ephemeral named Colima profile, removed afterward. It does
not use a larger runner, paid fallback, provider credentials or an operator profile.

Before the lengthy stock gates, a separate private-state capability step executes
the exact pinned OpenCode native optional-package binary with `--version` and a
real, zero-provider `printf` PTY. It never executes the npm postinstall or its
network fallback. The manifest versions, physical private path, executable and
actual version must match; a missing/mismatched binary fails with a bounded receipt.
The early check uses the CLI-host workspace's normal standalone build, then its
actual compiled PTY spawn entry for another exact-output `printf` control. It
records whether the selected native `stty` path is already executable. This does
not substitute for the later actual OpenCode/browser interaction.
On Darwin only, a real failed `posix_spawnp` probe plus the exact published
node-pty1.1.0 helper hash, mode0644, checkout confinement, ownership and single
link can authorize restoring that one helper's execute bits. The failure, modes,
unchanged bytes and successful second real probe are retained. Other failures
are not repaired or hidden; no installed/global dependency path is changed.
The same early step uses the hosted browser's isolated blank page to record its
actual version and long-character-event behavior, then verifies exact delivery
of the synthetic filter through awaited single-character events. It uses no
app/account session, paste, Enter, provider or model.
Before typing, the same private blank-page browser sets/reads/deletes a synthetic
loopback HttpOnly/SameSite=Lax cookie through CDP, checking its exact attributes
and deletion readback. No URL is fetched or navigated. Failure retains its phase
and selected pre-cleanup diagnostics; cleanup cannot replace the original error.
This early capability does not replace normal application setup/authentication.
Only on Darwin with CI exactly `true`, that fresh private proof-browser process
requests Chromium's documented `--use-mock-keychain` test switch. It selects the
in-process test keychain instead of the real macOS keychain, avoiding test dialogs.
Linux and non-CI argument lists stay unchanged; no owner-browser setting, OS
keychain, application authentication or other browser flag is changed. Receipts
disclose this configuration. Earlier Mac cookie timeouts remain cause-unconfirmed;
the exact cookie roundtrip and all actual application/TUI/lifecycle gates still
must pass at the new source.
The actual terminal proof uses that same bounded typing method while retaining
every live/menu/filter check.
Its capability state uses a short random name and refuses an existing directory;
full-size ownership/secret nonces remain unchanged. This avoids the Linux Chrome
singleton socket's small Unix path budget while keeping HOME/TMPDIR/profile in
that private state. Startup failures retain bounded redacted stderr, binary
version, exit/signal and selected paths; a terminated child fails immediately.
Failures after the CDP session opens retain the same selected browser snapshot,
socket state and failed CDP method before closing Chrome. Request parameters,
cookies, session URLs and environments are excluded. A missing `stty` message and
a CDP cookie timeout are distinct observations, without an assumed shared cause.

After those gates, `scripts/dev-stack/lifecycle-proof.mjs` starts a real stack with
synthetic installed ports4910/4911 occupied by an independent process. It exercises
HTTP owner claim and sign-in, invalidates the consumed token, creates the actual
Getting Started/OpenCode pane, observes the real PTY UI, and renders that pane in
the runner’s existing headless Chrome. Its current matching API/WS session must
remain active/RUNNING; error, exit or unexpected close is fatal. Keyboard input
targets only that pane's attached error-free terminal: Ctrl+P opens the pinned
command menu, a unique local filter produces the matching empty-result state,
Escape dismisses it, and Ctrl+P opens a fresh menu again. Only new output after
each input counts. No Enter, provider login or model prompt is sent. The private
provider HOME/XDG roots do not replace the pane's requested working directory.
Screen predicates use the already locked headless terminal renderer, matching
the canonical API projection. They await the complete observed ANSI stream at
the current session's generation-bound geometry, latched at the pre-input
baseline. Truncated/oversized replay, unknown geometry or any later dimension/
generation change fails explicitly. A known unfiltered menu must precede the
fresh challenge; current full value and empty-result state must follow new output.
Dismissal must remove the dialog/challenge before reopening. Historical or erased
text never counts. Selected synthetic frames are retained with cross-event secret
redaction, projected transition screens and a best-effort failure screenshot.
It changes a CSS canary and observes real
HMR without a navigation, then changes API/shared-package source and observes
rebuilt output plus new API/worker processes and restored readiness. All changed
source bytes are restored.

The same proof checks loopback sockets/permissions, down retaining the database,
a deliberately unavailable Docker endpoint retaining recovery state, normal reset,
a fresh state with alternate ports/new secrets, and an actual forced worker death.
An independent labeled container, volume and process must survive each launcher
cleanup. The proof finally removes its own separately labeled sentinels, and checks
that no owned containers/volumes/networks/processes/state or source changes remain.
Only redacted logs, check summaries and browser screenshots outside the checkout
are uploaded. A failed criterion remains failure; a green unit/build job is not a
substitute for a completed same-source Linux/macOS run.

To run that real proof on a disposable host whose Docker/browser already work:

```sh
export SPACE_DEV_CANDIDATE=$(git rev-parse HEAD)
export SPACE_DEV_PROOF_DIR=/absolute/private/path/outside/checkout
node scripts/dev-stack/lifecycle-proof.mjs
```

Only use a disposable development host: the proof deliberately edits/restores
three source files and binds4910/4911. It refuses pre-existing proof state and never
adopts an installed instance. Hosted transcripts certify their actual platform and
commit only; no unperformed Windows, provider-inference or desktop-install result
is implied.
