# run-spaceapp

Cross-platform Docker launcher for SpaceApp.

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

Host-root is supported only on Linux with Docker. Run
`npx --yes run-spaceapp@latest install --access isolated` to remove the host
mount while keeping SpaceApp data and volumes.

### Rootless Podman Support (Linux & macOS)

On Linux and macOS, you can run SpaceApp on rootless Podman 5 or newer instead
of Docker:

```bash
npx --yes run-spaceapp@latest install --engine podman
```

If Docker is missing on Linux or macOS and Podman 5+ with `podman compose` is
already ready, interactive `install` offers to use Podman instead of installing
Docker. The selected engine (`"docker"` or `"podman"`) is saved in `config.json`
and used automatically by all subsequent commands (`up`, `down`, `status`,
`logs`, `update`, `rollback`, `backup`, `restore`, `doctor`, `repair`,
`provider install`, `credentials`, `owner`, `uninstall`, and `factory-reset`).

- **Linux rootless**: Requires Podman >= 5 with `podman compose` (`docker-compose`
  v2 or `podman-compose`) and cgroup v2 (`cpu` and `memory` controllers delegated
  for resource limits). Registered workspaces (`workspace add`) and internal
  mounts automatically configure SELinux shared labels (`:z`) and
  `userns_mode: "keep-id:uid=10001,gid=10001"` so container UID `10001` maps to
  your host user without root privileges.
- **macOS (`podman machine`)**: Requires a running Podman machine with enough
  CPU, RAM, and disk for the chosen profile. If the machine is undersized, the
  launcher prints the exact `podman machine stop && podman machine set --cpus ... --memory ... --disk-size ... && podman machine start`
  command needed to resize it.
- **Podman limitations**:
  - Windows (`win32`) is not supported with `--engine podman`; use Docker Desktop on Windows 11.
  - `--access host-root` is refused on Podman because rootless user namespaces do not map host root `/`.
  - Switching engines in place on an existing installation is refused because Docker and Podman maintain separate volume stores. To migrate engines, run `npx --yes run-spaceapp@latest backup`, `npx --yes run-spaceapp@latest uninstall --purge-data`, `npx --yes run-spaceapp@latest install --engine podman`, and `npx --yes run-spaceapp@latest restore <archive>`.

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
npx --yes run-spaceapp@latest user enable      # Turn team accounts on (invite people in Settings -> Users)
npx --yes run-spaceapp@latest user add <user-id> # Give an invited user their own CLI container
npx --yes run-spaceapp@latest user restore <user-id> # Put a user's CLI settings and memory back from a backup
npx --yes run-spaceapp@latest uninstall      # Stop and remove containers (preserves data)
```

Uninstall retains data by default and prints the separate
`npm uninstall -g run-spaceapp` command for removing an optional global
launcher.
