# ADR-010: Public alpha distribution

## Status

Accepted

## Date

2026-07-23

## Context

Space was developed on a private operator VM and contains mature application
features alongside host-specific deployment assumptions. A public alpha must
install consistently on Linux, macOS, and Windows 11 without publishing owner
credentials, personal memory, private infrastructure values, or the private
repository's historical objects.

## Decision

Publish a sanitized clean-history repository as `oll4com/spaceapp` under
Apache License 2.0. Keep the application workspaces non-publishable and publish
one npm launcher package, `run-spaceapp`, whose executable is `spaceapp`.

The launcher manages a versioned Docker Compose application:

- native multi-architecture core and CLI-host images;
- an explicit amd64 compatibility CLI profile where a vendor runtime has no
  arm64 build;
- PostgreSQL/pgvector and Temporal;
- persistent but isolated provider credential, application data, and user
  memory volumes;
- explicit read/write workspace mounts selected by the owner.

The default bind is loopback-only. First launch uses a one-time setup claim;
production never enables development login or ships a default password.
Telemetry is disabled by default.

The public Git repository is created from a sanitized export of a verified
commit, not by pushing the private Git object graph. Release `0.1.0-alpha.1`
uses npm dist-tag `alpha`.

## CLI distribution policy

Codex, Claude Code, Gemini, OpenCode, Qwen Code, Kimi Code, Grok Build, and the
community DeepSeek package are installed at pinned versions in the CLI image.
Owners still complete each provider's official login flow or supply a key
through masked input; no credentials are bundled.

DeepSeek support is labeled community/experimental because
`run-deepseek-cli` is not an official DeepSeek CLI. Its install scripts are
disabled during the image build, and it remains opt-in at the credential/setup
boundary.

Each third-party CLI retains its own license and terms. SpaceApp does not bundle
credentials.

## Alternatives considered

### Publish the existing private repository

Rejected because deleted secrets and private infrastructure context can remain
reachable in Git history.

### Install all dependencies directly on the host

Rejected because it makes Windows/macOS parity, rollback, and clean-install
testing unreliable and mixes provider state with the owner's host environment.

### Ship a preconfigured VM image

Rejected as the primary distribution because VM formats are platform-specific,
large, difficult to update, and easy to confuse with a backup of the developer
instance. Docker Compose provides a reproducible cross-platform runtime while
the test lab still uses real clean VMs/runners.

### Install selected provider CLIs after container startup

Rejected because mutable runtime installation makes the release inventory,
clean-room reproduction, architecture checks, and rollback unreliable. The
image instead pins every currently supported CLI, while credential setup
remains explicit and provider terms remain independently applicable.

## Consequences

- Docker Desktop is required on Windows and macOS.
- A full profile needs at least 4 CPUs, 8 GB Docker memory, and 40 GB free disk;
  8 CPUs, 16 GB RAM, and 100 GB free are recommended.
- Release automation must prove sanitization, license inventory, secret scans,
  clean installation, upgrades, backups, and rollback.
- The REST API remains experimental during the alpha.
- Multi-user/RBAC support requires a separate security design and ADR.
