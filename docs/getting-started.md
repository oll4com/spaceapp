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
npx --yes run-spaceapp@latest install
```

Linux runs the containers directly through the host Docker Engine; SpaceApp
does not create a second guest VM. The launcher runs as the current non-root
user so the installation remains in that user's config directory. If Docker is
missing on Ubuntu, Debian, Fedora, RHEL, or CentOS, the launcher adds Docker's
official repository. On Arch-family systems, including CachyOS, it installs
the native `docker` and `docker-compose` packages through `pacman`. It then
starts the service. Before adding the current user to the `docker` group, it
explains that the group grants root-level privileges and asks for confirmation.

## macOS

Install Node.js 20.11 or newer, then run in Terminal:

```bash
npx --yes run-spaceapp@latest install
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
npx --yes run-spaceapp@latest install
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
when Docker becomes ready. Windows may request a UAC approval or one restart.
When WSL2 needs the restart, SpaceApp registers a one-time resume and asks
before scheduling it. Save your work, approve the restart, and sign back in;
the installer resumes automatically in Command Prompt without entering the
command again. SpaceApp reuses Docker Desktop's WSL2 Linux environment and does
not install a second full virtual machine.

## Installation profiles

The universal install command defaults to `--profile auto`:

| Profile | Selection | Included services | Resource posture |
| --- | --- | --- | --- |
| `light` | automatic default, or explicit | core, every bundled CLI, PostgreSQL, Temporal | supported on an 8 GB host; managed Chromium omitted |
| `standard` | explicit opt-in only | light services plus managed Chromium | recommended with 16 GB RAM |

Choose explicitly when needed:

```bash
npx --yes run-spaceapp@latest install --profile light
npx --yes run-spaceapp@latest install --profile standard
```

The light limits are 2 GiB for core, 1536 MiB for the CLI service, and 768 MiB
each for PostgreSQL and Temporal. These are upper bounds, not memory reserved
at startup.

## Linux host access

Installation profiles do not control filesystem permissions. Both `light` and
`standard` use isolated access by default, where only registered workspaces are
mounted.

The launcher-only `0.1.15-hostroot.1` personal candidate supports isolated
access only and reuses the existing `0.1.15-hostroot.0` runtime images:

```bash
npx --yes run-spaceapp@personal install
```

It rejects `--access host-root` until matching runtime images are rebuilt in a
future full release.

The earlier `0.1.15-hostroot.0` experiment can still be pinned explicitly on a
disposable, trusted single-owner Linux test machine:

```bash
npx --yes run-spaceapp@0.1.15-hostroot.0 install --access host-root
```

That mode remains one Docker-based SpaceApp build across Linux distributions.
It mounts the host `/` at `/host`, read-only in the core service and read/write
in the CLI service. The CLI service runs its sessions as container root only
in this mode. On a normal rootful Docker Engine, this is equivalent to
host-root file access: an agent can read credentials, change boot or package
files, or destroy the operating system.

The mode does not mount the Docker socket and does not enable `privileged`,
host PID, host network, host IPC, or host device access. Those omissions reduce
the attack surface but do not make a writable host root safe from a malicious
or mistaken CLI command.

Omitting `--access` preserves the current mode. New and migrated installations
default to `isolated`. To remove the host root mount while preserving SpaceApp
data, credentials, workspaces, secrets, and persistent volumes, run:

```bash
npx --yes run-spaceapp@personal install --access isolated
```

Use `npx --yes run-spaceapp@personal` for all follow-up commands while this
prerelease is installed.

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

The universal install command performs
`initialize → prerequisites → doctor → pull → up → readiness → setup status → open`. It creates
non-secret configuration, fresh database/session secrets, and a one-time setup
token; installs Docker from official sources when required; checks CPU, RAM,
free disk, Docker CLI, Compose, and engine readiness; downloads the selected
images; starts the services; waits up to ten minutes for `/readyz`; verifies
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
absolute path before every launcher command.

## Register a workspace

SpaceApp mounts no host project by default. Register only directories the CLI
tools are allowed to read or modify:

```bash
# Linux
npx --yes run-spaceapp@latest workspace add /home/alice/code/example

# macOS
npx --yes run-spaceapp@latest workspace add /Users/alice/code/example

# Windows PowerShell
npx --yes run-spaceapp@latest workspace add "C:\Users\Alice\code\example"
```

Use `--read-only` when the tools should not modify the directory:

```bash
npx --yes run-spaceapp@latest workspace add /absolute/path/to/reference --read-only
npx --yes run-spaceapp@latest workspace list
npx --yes run-spaceapp@latest workspace remove /absolute/path/to/reference
```

Adding a workspace grants the application CLIs access to that host directory.
Repository files are untrusted input, so review the project and its agent
instructions before allowing tools to operate on it.

Apply the updated mount list to the running stack:

```bash
npx --yes run-spaceapp@latest up
```

## First browser setup

The install command starts the stack and opens the first-run page. If the
browser was closed or `--no-open` was used, run
`npx --yes run-spaceapp@latest open`. The application binds to
`http://127.0.0.1:4911` by default.

On the first page:

1. copy the one-time setup token printed at the end of the install command and
   paste it into the field with the same name;
2. create the owner email and a password of at least 6 characters;
3. sign in as that owner;
4. connect one CLI provider at a time;
5. create a test room and verify the selected workspace;
6. run `npx --yes run-spaceapp@latest backup` before the first update.

There is no default owner password or production development-login fallback.
The setup claim is single-use.

If the 15-minute token expires before the first owner is claimed, rotate it
locally and use the newly printed value:

```bash
npx --yes run-spaceapp@latest owner rotate-setup-token
```

Rotation is refused after an owner exists.

## Connect providers

Open the CLI provider setup inside SpaceApp and use the provider's official
OAuth, device-code, or login flow. For providers that support direct API keys,
the launcher also accepts a value from masked standard input:

```bash
npx --yes run-spaceapp@latest credentials list
npx --yes run-spaceapp@latest provider install claude
npx --yes run-spaceapp@latest credentials set claude
npx --yes run-spaceapp@latest credentials set gemini
```

Credentials are never accepted as command-line arguments. See
[CLI providers](cli-providers.md) for bundled versus owner-installed versions,
authentication methods, storage boundaries, and the experimental DeepSeek
warning.

## Verify the installation

```bash
npx --yes run-spaceapp@latest doctor
npx --yes run-spaceapp@latest status
npx --yes run-spaceapp@latest logs
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
