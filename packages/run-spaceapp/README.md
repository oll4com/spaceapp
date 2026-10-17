# run-spaceapp

Cross-platform container launcher for SpaceApp. Docker remains the default;
rootless Podman is available on Linux and macOS.

## Rootless Podman

Install [Podman >=5](https://podman.io/docs/installation) and use
[Docker Compose >=2.24.4 as its external provider](https://docs.podman.io/en/latest/markdown/podman-compose.1.html).
Set `PODMAN_COMPOSE_PROVIDER` to the Docker Compose executable if Podman does not
discover it. The Python `podman-compose` provider is not supported. Docker
Compose itself is free and does not require a Docker daemon for this path.

```sh
npx --yes run-spaceapp@latest install --engine podman --profile small
```

The engine is saved in `config.json`; subsequent lifecycle, workspace, provider,
credential, backup, restore, repair and owner commands use it automatically.
The `engine` key also works in `--answers`. Without an explicit choice, a
working Docker installation is preferred. When Docker is unavailable and
Podman is installed, setup offers Podman (or selects it unattended).

Linux requires a rootless connection, cgroup v2, and delegated CPU and memory
controllers. `doctor` reports those facts, the engine and Compose versions,
and resource allocation. `support-bundle` includes only these selected engine
facts. Rootful connections and `--access host-root` are refused. Switching the
engine of an existing installation is refused because the other engine cannot
see its volumes; automated cross-engine migration is not supported.

On macOS create and start a rootless Podman machine first. Small, medium and
large require at least 4 machine CPUs and 3, 5 and 7 GiB of machine RAM
respectively, in addition to the existing host requirements. Allow disk space
for the reported image and checkpoint reserve. Stop a machine before resizing
it with `podman machine set --cpus 4 --memory <MiB> --disk-size <GiB> <name>`.
The launcher does not install or resize Podman machines. Windows Podman is out
of scope.

Workspace bind mounts use shared SELinux `z` labels and
`keep-id:uid=10001,gid=10001`, so files created by the application belong to the
calling host user. Read-only workspace mounts remain read-only. SpaceApp does
not recursively change host-workspace ownership. Before starting containers,
the launcher refuses missing or non-directory workspace paths. The Compose
bind configuration retains the shared SELinux label through its Bind API;
`create_host_path: false` would drop that label in the Mount API. The Podman override mounts
file-backed secrets read-only with shared SELinux labels; secret files remain
inside the private installation directory. Named data and socket volumes,
profiles, health dependencies, init, and resource limits are retained.

The opt-in acceptance command performs a real small-profile install, readiness
check, backup, and purge using a new isolated state directory:

```sh
node packages/run-spaceapp/tests/podman-acceptance.mjs
```

Set `SPACEAPP_ACCEPTANCE_EXTENDED=1` to also check writable/read-only workspaces,
host ownership, bundled OpenCode, repair, restart, restore, retained-data uninstall
and the support bundle. If the checkout version has no published images yet,
an explicit `SPACEAPP_ACCEPTANCE_RUNTIME_VERSION=1.1.5` selects that public runtime
fixture; the receipt states the tested version. It does not certify unpublished
runtime images. Restore and purge automation require `confirm:true` and the
explicit `restore:"RESTORE"` or `purge:"DELETE"` answers respectively.

It needs port 4911 to be unused and downloads the normal public images. It
never logs in to an AI provider or submits a model prompt. Unit tests and this
small-profile check do not certify all profiles or cross-engine migration.

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
