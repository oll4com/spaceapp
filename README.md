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
- an owner-initiated Claude installation flow that installs
  Claude Code into that installation's private provider volume;
- one-time first-owner setup with no default password;
- isolated, persistent provider state and mutable owner memory;
- explicit host workspace registration, including read-only mounts;
- an explicit Linux-only host-root mode for a trusted owner's personal
  installation, disabled by default;
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

Run the same command in Linux, macOS, or Windows 11 Command Prompt:

```bash
npx --yes run-spaceapp@latest install
```

This downloads the current launcher, installs missing Docker prerequisites,
selects the light profile, starts SpaceApp, and opens it. To keep a global
`spaceapp` command for later operations, install it separately:

```bash
npm install -g run-spaceapp
```

Keep `@latest` in the command. Under npm's
[exec contract](https://docs.npmjs.com/cli/v11/commands/npm-exec), a package
name without a version specifier can match an existing local package, while
the explicit specifier resolves the requested current release.

The universal install command creates the local configuration and fresh
secrets, installs Docker when it is missing, checks the host, selects a
resource profile, downloads the images, starts the stack, and opens the app.
It is idempotent, so running the same command again preserves data and
long-lived secrets. While the owner is still unclaimed, every successful
install issues a fresh 15-minute setup token that is accepted by the running
database.

The automatic prerequisite flow uses official Docker sources: Docker Desktop
through Windows Package Manager's hash-pinned manifest on Windows (with a
signed direct-download fallback), Docker Desktop on macOS, and Docker Engine
repositories on Ubuntu, Debian, Fedora, RHEL, and CentOS, or the native
`pacman` packages on Arch-family systems including CachyOS. Docker Desktop
license acceptance still requires confirmation. On Linux, the same command
explains the root-equivalent `docker` group and adds the current user
automatically. Windows may require one restart after WSL2 is enabled;
SpaceApp registers a one-time resume, asks before scheduling the restart, and
continues automatically after the user signs back in. The install command does
not need to be entered again.
On Docker Desktop's first launch, its **Welcome to Docker** window may require
one user choice before the Engine starts. On Windows, use the **Command
Prompt** profile in Windows Terminal because the default restricted PowerShell
policy can block npm's `npx.ps1` before SpaceApp starts. Select **Skip** in the
top-right (or sign in), accept any remaining Docker prompt, and keep the
terminal open.
SpaceApp waits for up to ten minutes and continues automatically as soon as
Docker is ready.

`auto` always selects the lightweight profile so the default stays usable on
an 8 GB host. Light mode keeps every bundled CLI, PostgreSQL, and Temporal but
omits managed Chromium. Use
`npx --yes run-spaceapp@latest install --profile standard` explicitly when the
managed browser container is required and the host has the recommended
resources.

### Personal Linux x64 candidate

The `0.1.15-hostroot.2` personal candidate contains the installer, owner setup,
and host-root CLI fixes for x64 Linux:

```bash
npx --yes run-spaceapp@personal install --access host-root
```

Host-root mounts Linux `/` read/write into `spaceapp-cli` and can expose every
credential or make the operating system unbootable. It is not part of the
stable cross-platform release. The candidate publishes new `core` and `cli`
images only for `linux/amd64`; it reuses the existing signed browser manifest
without rebuilding it. npm rejects this candidate on arm64 hosts.

The installer does not create or reserve a separate fixed-size VM. Linux uses
the native Docker Engine; Windows uses Docker Desktop's WSL2 Linux environment;
macOS uses Docker Desktop's lightweight Linux VM. Docker images consume real
space as they are downloaded, while Docker Desktop's virtual disk grows with
written data up to its configured limit rather than allocating that limit
immediately.

After the application passes readiness checks, the command prints a one-time
setup token and exact paste instructions. Enter it in the first browser page,
create the owner, register only the host workspaces SpaceApp may access, and
connect providers through official login flows or masked credential input. If
the token expires, run
`npx --yes run-spaceapp@personal owner rotate-setup-token`. The default address is
`http://127.0.0.1:4911`; do not expose it directly to an untrusted network.

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

In the default isolated mode, only workspaces added with
`npx --yes run-spaceapp@latest workspace add` are mounted. Core and CLI
containers run as an unprivileged application user, secrets are file-mounted,
and telemetry is disabled by default. The explicit Linux host-root prerelease
changes only this documented access boundary; it still does not mount the
Docker socket or enable privileged/host namespaces.

## Common commands

```bash
npx --yes run-spaceapp@latest status
npx --yes run-spaceapp@latest logs
npx --yes run-spaceapp@latest backup
npx --yes run-spaceapp@latest install
npx --yes run-spaceapp@latest rollback
npx --yes run-spaceapp@latest down
npx --yes run-spaceapp@latest uninstall
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
- [Linux host-root access decision](docs/decisions/ADR-011-linux-host-root-access.md)
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
