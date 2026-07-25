# SpaceApp

SpaceApp is a self-hosted workspace for running multiple AI coding CLIs in
isolated rooms. The application, browser runtime, database, workflow engine,
generic starter memory, and redistributable pinned CLI tools run in Docker;
the owner supplies only their provider credentials and the host workspaces
they deliberately register. Claude Code is installed separately through an
explicit owner-initiated command because its package is not open-source
redistributable.

## What SpaceApp provides

- one `spaceapp` launcher for Linux, macOS, and Windows 11;
- a versioned Docker Compose stack with no host Docker socket;
- pinned Codex, Gemini, OpenCode, Qwen Code, Kimi Code, Grok Build, and
  experimental community DeepSeek CLI runtimes;
- an owner-initiated `spaceapp provider install claude` flow that installs
  Claude Code into that installation's private provider volume;
- one-time first-owner setup with no default password;
- isolated, persistent provider state and mutable owner memory;
- explicit host workspace registration, including read-only mounts;
- portable, checksummed backups for application data, PostgreSQL, and owner
  memory.

SpaceApp is designed for **one trusted owner on one self-hosted
instance**. It is not a multi-tenant service or an isolation boundary between
mutually untrusted users.

## One-command installation

Requirements:

- Node.js 20.11 or newer for the launcher;
- at least 4 CPUs, 8 GB system RAM, and 15 GiB free disk;
- recommended for the standard browser profile: 8 CPUs, 16 GB RAM, and
  25 GiB free disk.

Linux:

```bash
sudo npm install -g run-spaceapp && spaceapp install
```

macOS:

```bash
npm install -g run-spaceapp && spaceapp install
```

Windows 11 PowerShell:

```powershell
npm install -g run-spaceapp; if ($LASTEXITCODE -eq 0) { spaceapp install }
```

`spaceapp install` creates the local configuration and fresh secrets, installs
Docker when it is missing, checks the host, selects a resource profile,
downloads the images, starts the stack, and opens the app. It is idempotent,
so running the same command again does not replace an existing setup token or
secrets.

The automatic prerequisite flow uses official Docker sources: Docker Desktop
through Windows Package Manager's hash-pinned manifest on Windows (with a
signed direct-download fallback), Docker Desktop on macOS, and Docker Engine
repositories on Ubuntu, Debian, Fedora, RHEL, and CentOS. Docker Desktop
license acceptance and Linux `docker` group membership require confirmation
inside the same command. Windows may require one restart after WSL2 is enabled;
rerun the same command afterward and it continues safely.
On Docker Desktop's first launch, its **Welcome to Docker** window may require
one user choice before the Engine starts. Select **Skip** in the top-right (or
sign in), accept any remaining Docker prompt, and keep the terminal open.
SpaceApp waits for up to ten minutes and continues automatically as soon as
Docker is ready.

`auto` selects the `light` profile on systems below 12 GiB RAM. Light mode is
the supported 8 GB option: it keeps every bundled CLI, PostgreSQL, and Temporal
but omits managed Chromium. Use `spaceapp install --profile light` to select it
explicitly, or `--profile standard` for the browser container.

The installer does not create or reserve a separate fixed-size VM. Linux uses
the native Docker Engine; Windows uses Docker Desktop's WSL2 Linux environment;
macOS uses Docker Desktop's lightweight Linux VM. Docker images consume real
space as they are downloaded, while Docker Desktop's virtual disk grows with
written data up to its configured limit rather than allocating that limit
immediately.

On a new installation the command prints a one-time setup token. Enter it in
the first browser page, create the owner, register only the host workspaces
SpaceApp may access, and connect providers through official login flows or
masked credential input. The default address is `http://127.0.0.1:4911`; do
not expose it directly to an untrusted network.

See [Getting started](docs/getting-started.md) for platform-specific paths,
workspace examples, the first-owner flow, and current source-checkout testing.

## Architecture

The launcher writes non-secret configuration to the current user's platform
config directory and manages four services in light mode or five in standard
mode:

| Service | Responsibility |
| --- | --- |
| `spaceapp-core` | API, web application, worker supervision, owner memory |
| `spaceapp-cli` | redistributable pinned CLIs, owner-installed providers, and isolated provider state |
| `spaceapp-browser` | sandboxed Chromium browser sessions; standard profile only |
| `postgres` | PostgreSQL with pgvector |
| `temporal` | durable workflow orchestration |

Only workspaces added with `spaceapp workspace add` are mounted. Core and CLI
containers run as an unprivileged application user, secrets are file-mounted,
and telemetry is disabled by default.

## Common commands

```bash
spaceapp status
spaceapp logs
spaceapp backup
spaceapp update 0.1.6
spaceapp rollback
spaceapp down
spaceapp uninstall
```

Portable backups include a PostgreSQL custom dump, application-data archive,
owner-memory archive, and checksummed manifest. Provider credentials, provider
login state, registered host workspace contents, and browser profiles are
intentionally excluded. Read [Operations](docs/operations.md) before an update
or restore.

## Documentation

- [Getting started](docs/getting-started.md)
- [CLI providers and credentials](docs/cli-providers.md)
- [Operations, backup, restore, and rollback](docs/operations.md)
- [Clean-room testing](docs/clean-room-testing.md)
- [Public release runbook](docs/public-release.md)
- [Security model](docs/security-model.md)
- [Public distribution decision](docs/decisions/ADR-010-public-distribution.md)
- [Contributing](CONTRIBUTING.md)
- [Community support](SUPPORT.md)
- [Security reporting](SECURITY.md)

## Development

Repository development requires Node.js 22 and npm:

```bash
npm ci
npm run check
npm test
npm run build
```

Docker is required for Compose validation and clean-install testing. Run
`npm run hygiene:preflight` before committing. Browser-facing changes also
require a real browser check with clean console and network results.

## License

SpaceApp source is licensed under the [Apache License 2.0](LICENSE). Integrated
provider CLIs remain subject to their own licenses and terms; SpaceApp does not
provide provider accounts, usage credits, or credentials. See
[Third-party notices](THIRD_PARTY_NOTICES.md).
