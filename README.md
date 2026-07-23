# SpaceApp

SpaceApp is a self-hosted workspace for running multiple AI coding CLIs in
isolated rooms. The application, browser runtime, database, workflow engine,
generic starter memory, and redistributable pinned CLI tools run in Docker;
the owner supplies only their provider credentials and the host workspaces
they deliberately register. Claude Code is installed separately through an
explicit owner-initiated command because its package is not open-source
redistributable.

> **Public alpha status:** the source tree is being prepared for its first
> sanitized release. The npm package and GHCR images referenced below have not
> been published yet. Do not expect the install command to work until an alpha
> release is announced.

## What the alpha provides

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

SpaceApp alpha is designed for **one trusted owner on one self-hosted
instance**. It is not a multi-tenant service or an isolation boundary between
mutually untrusted users.

## Quick start after the first release

Requirements:

- Node.js 20.11 or newer for the launcher;
- Docker Engine with Docker Compose on Linux, or Docker Desktop on macOS and
  Windows 11;
- at least 4 CPUs, 8 GB of Docker memory, and 40 GB free disk;
- recommended: 8 CPUs, 16 GB RAM, and 100 GB free disk.

Windows installations should use Docker Desktop's WSL2 backend.

```bash
npm install --global run-spaceapp@alpha
spaceapp init
spaceapp doctor
spaceapp workspace add /absolute/path/to/a/project
spaceapp up
spaceapp open
```

`spaceapp init` prints a one-time setup token on a new installation. Open the
loopback-only application, enter that token, and create the first owner. Then
connect one provider at a time through its official login flow or masked
credential input.

The default address is `http://127.0.0.1:4911`. Do not expose an alpha instance
directly to the public Internet.

See [Getting started](docs/getting-started.md) for platform-specific paths,
workspace examples, the first-owner flow, and current source-checkout testing.

## Architecture

The launcher writes non-secret configuration to the current user's platform
config directory and manages five Compose services:

| Service | Responsibility |
| --- | --- |
| `spaceapp-core` | API, web application, worker supervision, owner memory |
| `spaceapp-cli` | redistributable pinned CLIs, owner-installed providers, and isolated provider state |
| `spaceapp-browser` | sandboxed Chromium browser sessions |
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
spaceapp update 0.1.0-alpha.2
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
- [Public alpha distribution decision](docs/decisions/ADR-010-public-alpha-distribution.md)
- [Contributing](CONTRIBUTING.md)
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
