# Clean-room testing

A clean-room installation proves that SpaceApp does not depend on a
developer's home directory, credentials, memory, existing Docker volumes, or
private infrastructure. Keep this environment separate from the development
and production hosts.

## Recommended test lab

Maintain one disposable VM for release-candidate testing:

- 8 vCPUs, 16 GB RAM, and at least 100 GB free disk;
- a supported Linux distribution with a current Docker Engine and Compose v2;
- a non-admin test user allowed to run Docker;
- no copied developer configuration, provider credentials, personal memory,
  or application volumes;
- a clean snapshot before each release-candidate cycle.

Use CI runners for the launcher OS matrix, but keep the real VM because it
exercises long-running containers, disk ownership, backup/restore, browser
startup, and restart behavior.

## Source-checkout acceptance

Before public artifacts exist, start from a fresh clone of the candidate source
and build images locally:

```bash
npm ci
npm run check
npm test
npm run build
docker build --target core --tag ghcr.io/oll4com/spaceapp-core:0.1.0-alpha.1 .
docker build --target browser --tag ghcr.io/oll4com/spaceapp-browser:0.1.0-alpha.1 .
docker build --target cli --tag ghcr.io/oll4com/spaceapp-cli:0.1.0-alpha.1 .
npm install --global ./packages/run-spaceapp
```

Set a brand-new installation root. On Linux/macOS:

```bash
export SPACEAPP_HOME="$PWD/.clean-room-spaceapp"
spaceapp init
spaceapp doctor
spaceapp workspace add "$PWD/fixtures/sample-workspace"
spaceapp up
spaceapp open
```

On Windows PowerShell:

```powershell
$env:SPACEAPP_HOME = "$PWD\.clean-room-spaceapp"
spaceapp init
spaceapp doctor
spaceapp workspace add "$PWD\fixtures\sample-workspace"
spaceapp up
spaceapp open
```

The fixture must contain only synthetic test content. Do not use a personal or
production repository as the clean-room workspace.

## Release-artifact acceptance

Once npm and GHCR artifacts are explicitly published, repeat the test without
a source checkout:

```bash
npm install --global run-spaceapp@alpha
spaceapp init
spaceapp doctor
spaceapp workspace add /absolute/path/to/synthetic-workspace
spaceapp up
spaceapp open
```

This second pass proves the released npm tarball, image manifests, registry
permissions, and image architecture—not just the repository build.

## Required checks

For every candidate:

- `spaceapp init` creates only generic memory and fresh random secrets;
- configuration and secret files have restrictive host permissions;
- the default port is reachable only on loopback;
- all five Compose services become healthy/running;
- the first page requires the one-time setup claim;
- invalid setup input does not create an owner;
- a valid claim can create exactly one owner;
- no unregistered host directory is mounted;
- read-only and read/write workspace mounts behave as declared;
- every bundled CLI reports the pinned release inventory;
- no provider is ready until synthetic test credentials or official login is
  supplied;
- one test room and one CLI can run against the synthetic workspace;
- browser console and same-origin network checks are clean at desktop and
  mobile viewports;
- backup creates the dump, archives, and checksummed manifest;
- restore succeeds after a deliberate synthetic data change;
- update and rollback preserve application data;
- provider credentials and login state are absent from portable backups;
- uninstall keeps data by default, while confirmed purge removes volumes.

## Cross-platform matrix

The launcher test matrix must include:

| Platform | Required proof |
| --- | --- |
| Ubuntu | launcher tests, Compose validation, real clean-stack VM |
| macOS | launcher tests, path/config resolution, Docker Desktop smoke |
| Windows 11 | launcher tests, `%APPDATA%` path handling, WSL2 Docker smoke |

Container release validation must inspect both `linux/amd64` and
`linux/arm64` manifests where all pinned provider binaries support the
architecture. Any architecture exception must be explicit in release notes
and must not silently run an incompatible image.

## Reset between cycles

Use a VM snapshot or a new VM for the strongest proof. If reusing a host, use a
new `SPACEAPP_HOME`, verify the exact Compose project and volumes, and remove
only that test instance. Never use a blanket Docker or filesystem cleanup on a
shared host.
