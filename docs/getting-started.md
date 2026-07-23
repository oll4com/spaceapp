# Getting started

SpaceApp packages its application services and redistributable AI coding CLIs
in Docker. The host needs Node.js only for the small `spaceapp` launcher,
Docker, and enough resources for the stack.

> **Release status:** the first public npm package and container images are not
> published yet. Use the source-checkout procedure only for clean-room
> development until an alpha release is announced.

## Requirements

Minimum:

- 4 CPU cores;
- 8 GB memory assigned to Docker;
- 40 GB free disk;
- Node.js 20.11 or newer;
- Docker Compose v2.

Recommended for browser sessions and several simultaneous CLI panes:

- 8 CPU cores;
- 16 GB RAM;
- 100 GB free disk.

Platform notes:

- **Linux:** use Docker Engine and the Docker Compose plugin. The current user
  must be allowed to run Docker.
- **macOS:** use a current Docker Desktop release and allocate at least the
  minimum CPU, memory, and disk resources in Docker Desktop.
- **Windows 11:** use Docker Desktop with the WSL2 backend. Keep the project in
  a Docker-accessible drive or WSL filesystem and use PowerShell, Windows
  Terminal, or a WSL shell consistently.

## Install after release

```bash
npm install --global run-spaceapp@alpha
spaceapp init
spaceapp doctor
```

`spaceapp init` creates the installation root, non-secret configuration,
Compose files, random database and session secrets, and a one-time setup token.
The token is printed only when a new token is generated. Keep it temporary and
do not paste it into issues, chat transcripts, screenshots, or shell history.

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

## Start and claim the instance

```bash
spaceapp up
spaceapp open
```

The web application binds to `http://127.0.0.1:4911` by default. On the first
page:

1. enter the one-time setup token printed by `spaceapp init`;
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

`doctor` checks Node.js, Docker, and Docker Compose. `status` should show the
core, CLI, browser, PostgreSQL, and Temporal services running. If startup is
still in progress, wait for the health checks and inspect bounded logs.

## Current source-checkout test path

Until release artifacts exist, a clean-room operator can build the three local
images with the exact alpha tag expected by the launcher:

```bash
npm ci
docker build --target core --tag ghcr.io/oll4com/spaceapp-core:0.1.0-alpha.1 .
docker build --target browser --tag ghcr.io/oll4com/spaceapp-browser:0.1.0-alpha.1 .
docker build --target cli --tag ghcr.io/oll4com/spaceapp-cli:0.1.0-alpha.1 .
npm install --global ./packages/run-spaceapp
```

Then set a new `SPACEAPP_HOME` and follow `init → doctor → workspace add → up
→ open`. This proves a source build; it does **not** prove that npm or GHCR
release artifacts are available. Follow [Clean-room testing](clean-room-testing.md)
for the complete acceptance checklist.
