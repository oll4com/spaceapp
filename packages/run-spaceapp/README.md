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
RAM and free disk. Docker and Podman resource allocations are checked as well.

### Container Engines: Docker and Podman

The launcher defaults to Docker. It also supports **rootless Podman** (Podman ≥ 5 with `podman-compose` or `docker-compose` provider) on Linux and macOS (`podman machine`):

```bash
npx --yes run-spaceapp@latest install --engine podman
```

- **Selection**: Pass `--engine docker|podman`. The selected engine is saved in `config.json` and reused by all subsequent commands (`up`, `down`, `backup`, `restore`, `doctor`, etc.). When `--engine` is omitted, Docker is preferred if available. If only Podman is detected, interactive setup prompts to use it (or selects it automatically with `--non-interactive`).
- **SELinux**: On Linux distributions with SELinux enforcing (such as Fedora/RHEL), bind mounts configured via `workspace add` are automatically tagged with `:z` (`selinux: "z"`) to ensure correct permissions.
- **Data safety**: Docker volumes are not accessible to Podman (and vice-versa). Directly switching engines on an existing installation is blocked. To switch engines safely, run `spaceapp backup` to export an archive, reinstall with `--engine <new-engine>`, and run `spaceapp restore`.
- **Host-root access**: `--access host-root` is strictly refused when running on Podman.
- **macOS Podman Machine**: On macOS, the launcher inspects CPU, memory, and disk allocated to the default `podman machine` and guides you to resize it (`podman machine stop`, `podman machine set --cpus ... --memory ...`, `podman machine start`) if requirements are not met.


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

Telemetry is off unless you turn it on. The install wizard asks "Enable
anonymous usage telemetry?" and the default answer is No. Only when you answer
Yes (or pass `"telemetry": true` in `--answers`) does a successful first
install (not an upgrade or re-run) send one ping to
`https://spaceapp.dev/install-ping.php`. Its body contains only: a random ID
generated for that ping, the operating system and CPU architecture, the
launcher and runtime versions, and the install date. It contains no files,
credentials, workspace paths, or account details.

With the same Yes, SpaceApp 1.1.4 and later also send one `first_answer` event,
once per installation, the first time an agent in the app finishes an answer. It
goes to the same address and contains only the event name, a new random ID (not
linked to the install ping or to anything in your installation), the SpaceApp
version, the CPU architecture and the date. No prompt, answer, model, account or
path is sent. A failed send is retried at most every ten minutes until it succeeds
once. With telemetry No, nothing is sent.

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
