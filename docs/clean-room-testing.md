# Clean-room testing

A clean-room installation proves that SpaceApp does not depend on a
developer's home directory, credentials, memory, existing Docker volumes, or
private infrastructure. Keep this environment separate from the development
and production hosts.

## Recommended test lab

Maintain one disposable VM for release-candidate testing:

- 4 vCPUs, 8 GB RAM, and a 40 GiB sparse/grow-on-write virtual disk with at
  least 15 GiB free inside the guest;
- a supported Linux distribution with a current Docker Engine and Compose v2;
- a non-admin test user allowed to run Docker;
- no copied developer configuration, provider credentials, personal memory,
  or application volumes;
- a clean snapshot before each release-candidate cycle.

The 40 GiB virtual size is a test-lab ceiling, not immediate host allocation.
Use thin/sparse storage so the backing file or ZFS volume grows only with data.
This VM intentionally exercises the automatically selected `light` profile.
Run a separate 16 GB standard-profile cycle when managed browser sessions are
part of the candidate.

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
docker build --target core --tag ghcr.io/oll4com/spaceapp-core:0.1.0 .
docker build --target browser --tag ghcr.io/oll4com/spaceapp-browser:0.1.0 .
docker build --target cli --tag ghcr.io/oll4com/spaceapp-cli:0.1.0 .
npm install -g ./packages/run-spaceapp
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

Once npm and GHCR artifacts are published, repeat the test without a source
checkout. Linux:

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

For a Windows image without Docker Desktop, verify the first-run handoff as
part of acceptance: the terminal must identify the **Welcome to Docker** screen,
tell the tester to select **Skip** (or sign in), remain open while Docker starts,
and continue automatically without rerunning the command once the Engine is
ready.

This second pass proves the released npm tarball, image manifests, registry
permissions, and image architecture—not just the repository build.

## Required checks

For every candidate:

- `spaceapp init` creates only generic memory and fresh random secrets;
- configuration and secret files have restrictive host permissions;
- the default port is reachable only on loopback;
- core, CLI, PostgreSQL, and Temporal become healthy/running in light mode;
- the browser service also becomes healthy in a separate standard-profile
  cycle;
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
