# Getting started

SpaceApp packages its application services and redistributable AI coding CLIs
in Docker. The host needs Node.js only for the small `spaceapp` launcher,
Docker, and enough resources for the stack.

## Requirements

Minimum:

- 4 CPU cores;
- 8 GB system RAM;
- 15 GiB free disk;
- Node.js 20.11 or newer;
- Docker Compose v2.

Recommended for browser sessions and several simultaneous CLI panes:

- 8 CPU cores;
- 16 GB RAM;
- 25 GiB free disk.

## Linux

Install Node.js 20.11 or newer, Docker Engine, and the Docker Compose plugin.
Start Docker and ensure the current non-root user can run `docker version` and
`docker compose version`, then run:

```bash
npm install -g run-spaceapp && spaceapp install
```

Linux runs the containers directly through the host Docker Engine; SpaceApp
does not create a second guest VM.

## macOS

Install Node.js 20.11 or newer and a current Docker Desktop for Mac release,
start Docker Desktop, then run in Terminal:

```bash
npm install -g run-spaceapp && spaceapp install
```

Docker Desktop uses its managed lightweight Linux environment. Apple Silicon
uses the native `linux/arm64` images and Intel Macs use `linux/amd64`.

## Windows 11 — PowerShell

Enable hardware virtualization and WSL2, install Node.js 20.11 or newer, and
install Docker Desktop with the WSL2 backend. Start Docker Desktop, open
PowerShell or Windows Terminal, and run:

```powershell
npm install -g run-spaceapp; if ($LASTEXITCODE -eq 0) { spaceapp install }
```

SpaceApp reuses Docker Desktop's WSL2 Linux environment. It does not install a
second full virtual machine. Keep each workspace in a location Docker Desktop
can access and use one shell style consistently for paths.

## Installation profiles

`spaceapp install` defaults to `--profile auto`:

| Profile | Selection | Included services | Resource posture |
| --- | --- | --- | --- |
| `light` | automatically below 12 GiB RAM, or explicit | core, every bundled CLI, PostgreSQL, Temporal | supported on an 8 GB host; managed Chromium omitted |
| `standard` | automatically at or above 12 GiB RAM, or explicit | light services plus managed Chromium | recommended with 16 GB RAM |

Choose explicitly when needed:

```bash
spaceapp install --profile light
spaceapp install --profile standard
```

The light limits are 2 GiB for core, 1536 MiB for the CLI service, and 768 MiB
each for PostgreSQL and Temporal. These are upper bounds, not memory reserved
at startup.

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

`spaceapp install` performs `initialize → doctor → pull → up → open`. It
creates non-secret configuration, fresh database/session secrets, and a
one-time setup token; checks CPU, RAM, free disk, Docker, and Compose; downloads
the selected images; starts the services; and opens
`http://127.0.0.1:4911`.

The command is idempotent. Running it again preserves the installation's
secrets, data, provider state, and existing unclaimed setup token. Use
`--no-open` on headless machines.

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

1. enter the one-time setup token printed by `spaceapp install`;
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

`doctor` checks Node.js, Docker, Docker Compose, CPU, memory, and free disk.
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
