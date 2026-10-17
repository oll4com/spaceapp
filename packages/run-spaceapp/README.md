# run-spaceapp

Cross-platform Docker launcher for SpaceApp.

### Rootless Podman (Linux and macOS)

Docker remains the default. To use an existing Podman installation:

```bash
npx --yes run-spaceapp@latest install --engine podman --profile small
```

Requirements: Podman >=5, rootless mode, cgroup v2 with CPU and memory
controllers delegated, and **Docker Compose >=2.24** as the external
`podman compose` provider. The Python `podman-compose` provider is not supported.
Set `PODMAN_COMPOSE_PROVIDER` to the Docker Compose executable if necessary.
The launcher does not install Podman or its Compose provider. On Linux it starts
only the current user's `podman.socket`, never a root daemon or a privileged
service. Run as your normal user with subordinate UID/GID mappings configured.

On macOS, create and start a rootless Podman machine first. Allocate at least
the CPU and RAM listed for the selected profile below, plus a virtual disk of
20 GiB (`small`), 24 GiB (`medium`) or 32 GiB (`large`), including OS headroom.
Virtual disk capacity is not a measurement of its remaining free space; `doctor` reports
insufficient allocations and prints `podman machine set` resize instructions.
Host bind paths must be shared with the machine. Windows Podman is not supported.

The engine choice is saved and used by every lifecycle command, including
checkpoints, backup/restore, diagnostics and provider installation. The same
choice is available as `"engine":"podman"` in `--answers`. Without an explicit
choice, a new isolated installation uses Docker if ready; otherwise it offers
an available Podman engine (selects it in non-interactive mode).
Existing installations retain their engine. Switching engines is refused:
Docker and Podman volumes are separate, and no automatic migration is provided.
Use a different `SPACEAPP_HOME` for an independent fresh installation.

`--access host-root` is not supported with Podman. Registered workspaces use a
shared SELinux `z` label and a keep-id mapping from container UID/GID 10001 to
the invoking host user; they are not recursively chowned. Register only
directories you own and intend to share: SELinux relabeling changes their
labels, including on read-only mounts. `--read-only` is enforced by the mount.
Secrets and backup binds are relabeled individually, not the whole home.
The published images, Compose profiles, file-based secrets and resource limits
are unchanged; no Podman-specific images are used.

`doctor` and `support-bundle` report allowlisted engine/version, rootless,
cgroup, CPU/memory delegation, provider and macOS machine resource facts.
They do not include raw engine metadata or registry credentials.

To test a source checkout with a running rootless engine, use
`node scripts/podman-launcher-smoke.mjs small` (also `medium` or `large`).
`--extended` additionally exercises workspace ownership/read-only access,
restore, repair, provider verification and normal stop/remove operations.
`--upgrade-from=1.1.4` installs the actual older published images, updates to
the checkout's runtime version, verifies its checkpoint, rolls back and checks
readiness. Each run uses an unpredictable temporary installation/project,
purges only its own test volumes/network and removes the fixture on exit.
Do not use an operator installation as a fixture; port 4911 must be free.
These opt-in checks download images but do not need accounts or provider keys.

The Ubuntu Podman CI job builds the unchanged release Dockerfile's `core` and
`cli` targets locally, imports them into rootless Podman, and runs the smoke
fixture with `--local-images`. This tests the candidate even before its release
tags are published; nothing is pushed to a registry. Docker is only the CI
image builder, not the runtime engine. The fixture reports the runtime version
and whether local images were used. Normal installs still download the
maintainer's published images and do not silently fall back to another release.

Run the same command in Linux, macOS, or Windows 11 Command Prompt:

```bash
npx --yes run-spaceapp@latest install
```

To keep a global `spaceapp` command for later operations, install it
separately:

```bash
npm install -g run-spaceapp
```

The smallest profile requires Node.js 20.11 or newer, 4 CPUs, 8 GB-class RAM
(7 GiB usable), and 6.5 GiB free for a fresh installation. Keep `@latest` in the command so npm resolves the current release instead
of matching an existing local launcher. If Docker is missing, the universal
install command automatically installs it from official Docker sources on
Windows, macOS, Ubuntu, Debian, Fedora, RHEL, and CentOS, or with native
`pacman` packages on Arch-family Linux including CachyOS. It starts Docker and
waits for Engine and Compose readiness before pulling images. Windows prefers
Windows Package Manager's hash-pinned Docker Desktop
manifest and retains a signed direct-download fallback. Docker Desktop license
acceptance still requires confirmation. On Linux, the same command explains
the root-equivalent `docker` group and adds the current user automatically.
On Windows, approve any UAC prompt required by WSL2 or Docker
Desktop. Use the **Command Prompt** profile because a restricted PowerShell
policy can block npm's `npx.ps1` before SpaceApp starts. On Docker Desktop's
first launch, select **Skip** in the top-right of the **Welcome to Docker**
window (or sign in), accept any remaining Docker prompt, and keep the terminal
open. SpaceApp waits for up to ten minutes and continues automatically when
Docker is ready. If WSL2 requires one restart, SpaceApp registers a one-time
resume and asks before scheduling it. Sign back in after Windows restarts; the
same install continues automatically in Command Prompt without entering a
second command. Headless Windows sessions (SSH, CI services, session 0) also
work: during image pulls the launcher switches Docker to a temporary
credential-free config so Docker Desktop's graphical credential helper is never
invoked outside an interactive logon.

The launcher selects `small`, `medium`, or `large` automatically using CPU,
RAM and free disk. Docker's CPU and RAM allocation is checked as well.

| Profile | CPU | Usable RAM | Fresh free space | Services |
| --- | --- | --- | --- | --- |
| small | 4 | 7 GiB | 6.5 GiB | SpaceApp, OpenCode, PostgreSQL |
| medium | 4 | 11 GiB | 8 GiB | small + background workflow/integration workers |
| large | 8 | 15 GiB | 11 GiB | medium + managed Chromium, larger limits |

Use `install --profile small|medium|large` to choose explicitly. Existing
`light` and `standard` profiles remain compatible. Upgrades preserve the installed
profile unless you explicitly choose another one. Companions and additional AI
CLIs remain optional and can be installed when needed.

An upgrade checks **additional** space: missing image layers, the database
checkpoint and 0.5 GiB headroom. Cached target images require no extra image space.
Shared layers are excluded when public registry metadata is available; otherwise
a conservative estimate is shown. Space is checked again after pulling and
before pausing writers. Existing data is kept in place; the launcher never deletes
images, backups or volumes to free space. Separate Docker disk capacity is checked
when measurable and its availability is reported.

### Telemetry

Telemetry is off unless you turn it on. The install wizard lists what is sent
and asks "Enable anonymous usage telemetry?"; the default answer is No. Only
when you answer Yes (or pass `"telemetry": true` in `--answers`) does a first
install (not an upgrade or re-run) get a random install ID, stored as
`installId` in `config.json` and passed to SpaceApp as `SPACE_INSTALL_ID`, and
send events to `https://spaceapp.dev/install-ping.php`, each with a new random
event ID and that install ID:

- `install_started`: operating system and its version, CPU architecture, CPU
  count, RAM in GiB, profile, access mode, launcher and runtime versions.
- `install_completed` or `install_failed`: the duration and, on failure, the
  step that failed (`resources`, `docker`, `doctor`, `pull`, `storage`, `start`,
  `ready`, `owner_setup`, `cleanup`).
- From SpaceApp: `setup_completed` (the owner account was created), `first_cli`
  (which CLI started first, for example `opencode`), `first_answer` (an agent
  finished its first answer) and at most one `active` event a day when the owner
  opens SpaceApp, with the screen size, pixel ratio, browser family and major
  version, UI language and SpaceApp version.

The site derives the country from the request and never stores the IP address.
No files, prompts, answers, models, credentials, workspace paths or account
details are sent. A failed send from SpaceApp is retried at most every ten
minutes. Installations created by earlier launchers have no install ID and send
only the single install ping and `first_answer` event they were told about.
With telemetry No, nothing is sent.

The environment variable `SPACEAPP_TELEMETRY` overrides the answer: `0`, `false`,
`no` or `off` never send the ping or the `first_answer` event; `1`, `true`,
`yes` or `on` send them, which is how unattended installs opt in.

The legacy `light` profile runs the workflow service without managed Chromium;
`standard` runs both. Resource limits are maximums, not immediate RAM or
disk reservations. The launcher stores only non-secret configuration in the
current user's platform config directory:

- Linux: `$XDG_CONFIG_HOME/spaceapp` or `$HOME/.config/spaceapp`
- macOS: `$HOME/Library/Application Support/SpaceApp`
- Windows: `%APPDATA%\SpaceApp`

Set `SPACEAPP_HOME` to an absolute path to use a dedicated installation root.

On Linux, host-root access mounts the host `/` at `/host` (read/write in the
CLI service), so CLI sessions can read and modify the entire host. Read the
[security model](https://github.com/oll4com/spaceapp/blob/main/docs/security-model.md)
before enabling it:

```bash
npx --yes run-spaceapp@latest install --access host-root
```

Host-root is supported only on Linux. Run
`npx --yes run-spaceapp@latest install --access isolated` to remove the host
mount while keeping SpaceApp data and volumes.

Provider API keys are read from masked standard input and written to
restrictive files outside Git. OAuth and device-code credentials remain in
isolated Docker provider state. Neither credential source is included in
portable SpaceApp backups.

Claude Code is not redistributed in SpaceApp images. Install the reviewed
package as an explicit owner action with:

```bash
npx --yes run-spaceapp@latest provider install claude
```

Run `npx --yes run-spaceapp@latest help` for the complete command list. Full
documentation:

- [Getting started](https://github.com/oll4com/spaceapp/blob/main/docs/getting-started.md)
- [CLI providers](https://github.com/oll4com/spaceapp/blob/main/docs/cli-providers.md)
- [Operations](https://github.com/oll4com/spaceapp/blob/main/docs/operations.md)
- [Security model](https://github.com/oll4com/spaceapp/blob/main/docs/security-model.md)

After the stack passes readiness checks, the install command prints the fresh
15-minute token to paste into the browser's **One-time setup token** field. If
it expires before the owner is created, run:

```bash
npx --yes run-spaceapp@latest owner rotate-setup-token
```

### Self-Hosted Installation Help & Recovery

- **Forgot your operator password?** Run in your host terminal:
  ```bash
  npx --yes run-spaceapp@latest owner reset-password
  ```
- **Need a clean install from scratch?** Run:
  ```bash
  npx --yes run-spaceapp@latest factory-reset
  ```

### Common Commands

```bash
npx --yes run-spaceapp@latest status         # Check container health and port bindings
npx --yes run-spaceapp@latest logs           # Show recent container log lines
npx --yes run-spaceapp@latest doctor         # Verify system prerequisites and diagnose Docker
npx --yes run-spaceapp@latest up             # Start containers in background
npx --yes run-spaceapp@latest down           # Stop containers cleanly
npx --yes run-spaceapp@latest open           # Open web app in default browser
npx --yes run-spaceapp@latest backup         # Create verified, portable backup archive
npx --yes run-spaceapp@latest restore        # Restore state from a backup archive
npx --yes run-spaceapp@latest update         # Pull latest images and upgrade stack
npx --yes run-spaceapp@latest rollback       # Return to the previously recorded image version
npx --yes run-spaceapp@latest workspace add <path> # Register host folder for AI CLIs
npx --yes run-spaceapp@latest workspace list       # List registered host folders
npx --yes run-spaceapp@latest credentials list     # List provider names accepted by credentials set
npx --yes run-spaceapp@latest credentials set <provider> # Set API key via masked input
npx --yes run-spaceapp@latest uninstall      # Stop and remove containers (preserves data)
```

Uninstall retains data by default and prints the separate
`npm uninstall -g run-spaceapp` command for removing an optional global
launcher.
