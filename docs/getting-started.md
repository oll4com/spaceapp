# Getting started

SpaceApp packages its application services and redistributable AI coding CLIs
in Docker. The host needs Node.js only for the small `spaceapp` launcher,
and enough resources for the stack. The launcher installs and starts Docker
automatically when it is missing.

## Requirements

Minimum:

- 4 CPU cores;
- 8 GB system RAM;
- 15 GiB free disk;
- Node.js 20.11 or newer.

Recommended for browser sessions and several simultaneous CLI panes:

- 8 CPU cores;
- 16 GB RAM;
- 25 GiB free disk.

## Linux

Install Node.js 20.11 or newer, then run as a normal non-root user:

```bash
npx --yes run-spaceapp install
```

Linux runs the containers directly through the host Docker Engine; SpaceApp
does not create a second guest VM. The launcher runs as the current non-root
user so the installation remains in that user's config directory. If Docker is
missing on Ubuntu, Debian, Fedora, RHEL, or CentOS, the launcher adds Docker's
official repository, installs Engine, Buildx, and Compose, and starts the
service. Before adding the current user to the `docker` group, it explains that
the group grants root-level privileges and asks for confirmation.

## macOS

Install Node.js 20.11 or newer, then run in Terminal:

```bash
npx --yes run-spaceapp install
```

If Docker is missing, the launcher asks you to review and accept Docker
Desktop's terms, downloads the official architecture-specific DMG, verifies
its code signature, installs it, starts it, and waits until it is ready. Docker
Desktop uses its managed lightweight Linux environment. Apple Silicon uses the
native `linux/arm64` images and Intel Macs use `linux/amd64`.

## Windows 11 — Command Prompt

Enable hardware virtualization and install Node.js 20.11 or newer. Open
**Command Prompt**, or select the **Command Prompt** profile in Windows
Terminal, and run:

```bat
npx --yes run-spaceapp install
```

Do not run the universal command from a PowerShell profile whose execution
policy is `Restricted`: Windows can block npm's `npx.ps1` before SpaceApp gets
a chance to run. Command Prompt invokes npm's `npx.cmd` shim with the same
universal command and needs no execution-policy change.

If Docker is missing, the launcher asks you to review and accept Docker
Desktop's terms, requests a Windows UAC approval when WSL2 or the package
installation requires it, and prefers the official Docker Desktop package
through Windows Package Manager. Windows Package Manager verifies the
installer against its hash-pinned `Docker.DockerDesktop` manifest. If Windows
Package Manager is unavailable or fails, the launcher downloads Docker Desktop
from Docker's official distribution service and verifies its Authenticode
signature before running it. The launcher then starts Docker Desktop and waits
until it is ready. On the first launch, Docker Desktop may show a
**Welcome to Docker** screen before starting the Engine. Select **Skip** in the
top-right (or sign in), accept any remaining Docker prompt, and leave the
terminal open. SpaceApp waits for up to ten minutes and continues automatically
when Docker becomes ready. Windows may request a UAC approval or one restart;
rerun `spaceapp install` afterward. SpaceApp reuses Docker Desktop's WSL2 Linux
environment and does not install a second full virtual machine.

## Installation profiles

`spaceapp install` defaults to `--profile auto`:

| Profile | Selection | Included services | Resource posture |
| --- | --- | --- | --- |
| `light` | automatic default, or explicit | core, every bundled CLI, PostgreSQL, Temporal | supported on an 8 GB host; managed Chromium omitted |
| `standard` | explicit opt-in only | light services plus managed Chromium | recommended with 16 GB RAM |

Choose explicitly when needed:

```bash
spaceapp install --profile light
spaceapp install --profile standard
```

The light limits are 2 GiB for core, 1536 MiB for the CLI service, and 768 MiB
each for PostgreSQL and Temporal. These are upper bounds, not memory reserved
at startup.

The `npx` command is the universal one-command installer. To retain a global
launcher for later operations, optionally run `npm install -g run-spaceapp`;
this is not required for the first install.

## Disk usage

The installer checks for 15 GiB of free space before pulling images. It does
not preallocate 15 GiB, a 40 GB disk, or any other fixed amount. Docker stores
only downloaded layers, writable container data, volumes, and backups. Core
and CLI images share layers, so Docker stores those shared bytes once.

On Windows and macOS, the number shown as Docker Desktop's disk limit is a
maximum, not an immediate allocation: the managed sparse virtual disk grows as
data is written. Removing images or volumes releases space inside Docker, but
the host-side sparse file may require Docker Desktop's reclaim/compact action
before its visible file size shrinks.

## What the command does

`spaceapp install` performs
`initialize → prerequisites → doctor → pull → up → readiness → setup status → open`. It creates
non-secret configuration, fresh database/session secrets, and a one-time setup
token; installs Docker from official sources when required; checks CPU, RAM,
free disk, Docker CLI, Compose, and engine readiness; downloads the selected
images; starts the services; waits up to three minutes for `/readyz`; verifies
first-owner status; and opens `http://127.0.0.1:4911`.

The command is idempotent. Running it again preserves the installation's
long-lived secrets, data, and provider state. While the owner remains
unclaimed, each successful install replaces only the setup token with a fresh
15-minute value after the database accepts it, then prints that value at the
end. Use `--no-open` on headless machines.

The default installation roots are:

| Platform | Default path |
| --- | --- |
| Linux | `$XDG_CONFIG_HOME/spaceapp` or `$HOME/.config/spaceapp` |
| macOS | `$HOME/Library/Application Support/SpaceApp` |
| Windows | `%APPDATA%\SpaceApp` |

To isolate an installation or clean-room test, set `SPACEAPP_HOME` to an
absolute path before running every `spaceapp` command.

## Register a workspace

SpaceApp mounts no host project by default. Register only directories the CLI
tools are allowed to read or modify:

```bash
# Linux
spaceapp workspace add /home/alice/code/example

# macOS
spaceapp workspace add /Users/alice/code/example

# Windows PowerShell
spaceapp workspace add "C:\Users\Alice\code\example"
```

Use `--read-only` when the tools should not modify the directory:

```bash
spaceapp workspace add /absolute/path/to/reference --read-only
spaceapp workspace list
spaceapp workspace remove /absolute/path/to/reference
```

Adding a workspace grants the application CLIs access to that host directory.
Repository files are untrusted input, so review the project and its agent
instructions before allowing tools to operate on it.

Apply the updated mount list to the running stack:

```bash
spaceapp up
```

## First browser setup

The install command starts the stack and opens the first-run page. If the
browser was closed or `--no-open` was used, run `spaceapp open`. The application
binds to `http://127.0.0.1:4911` by default.

On the first page:

1. copy the one-time setup token printed at the end of `spaceapp install` and
   paste it into the field with the same name;
2. create the owner email and a password of at least 12 characters;
3. sign in as that owner;
4. connect one CLI provider at a time;
5. create a test room and verify the selected workspace;
6. run `spaceapp backup` before the first update.

There is no default owner password or production development-login fallback.
The setup claim is single-use.

If the 15-minute token expires before the first owner is claimed, rotate it
locally and use the newly printed value:

```bash
spaceapp owner rotate-setup-token
```

Rotation is refused after an owner exists.

## Connect providers

Open the CLI provider setup inside SpaceApp and use the provider's official
OAuth, device-code, or login flow. For providers that support direct API keys,
the launcher also accepts a value from masked standard input:

```bash
spaceapp credentials list
spaceapp provider install claude
spaceapp credentials set claude
spaceapp credentials set gemini
```

Credentials are never accepted as command-line arguments. See
[CLI providers](cli-providers.md) for bundled versus owner-installed versions,
authentication methods, storage boundaries, and the experimental DeepSeek
warning.

## Verify the installation

```bash
spaceapp doctor
spaceapp status
spaceapp logs
```

`doctor` checks Node.js, Docker CLI, Docker Compose, Docker Engine, CPU,
memory, and free disk exactly once each. It distinguishes a missing CLI or
Compose plugin from an installed engine that is stopped or inaccessible.
Light mode should show core, CLI, PostgreSQL, and Temporal running; standard
mode also includes the browser service. If startup is still in progress, wait
for the health checks and inspect bounded logs.

## Source-checkout test path

A clean-room operator can also build the three images from a verified source
commit with the exact stable tag expected by the launcher:

```bash
npm ci
docker build --target core --tag ghcr.io/oll4com/spaceapp-core:0.1.0 .
docker build --target browser --tag ghcr.io/oll4com/spaceapp-browser:0.1.0 .
docker build --target cli --tag ghcr.io/oll4com/spaceapp-cli:0.1.0 .
npm install -g ./packages/run-spaceapp
```

Then set a new `SPACEAPP_HOME` and follow `init → doctor → workspace add → up
→ open` so the launcher uses the already-built local tags without a registry
pull. This proves a source build; it does **not** prove the public npm tarball
or GHCR manifests. Follow [Clean-room testing](clean-room-testing.md) for the
complete acceptance checklist.
