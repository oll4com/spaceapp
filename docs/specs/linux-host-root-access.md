# Spec: Linux host-root access

## Objective

Add an explicit Linux-only execution mode to the existing SpaceApp
distribution so the trusted owner's AI CLI sessions can inspect and modify the
host Linux installation without creating a separate native product or a build
per distribution.

The same `run-spaceapp` launcher and GHCR images remain the distribution unit.
The initial release is a personal prerelease, `0.1.15-hostroot.0`, and must not
replace npm `latest` until isolated-VM acceptance succeeds.

The public command contract is additive:

```sh
npx --yes run-spaceapp@0.1.15-hostroot.0 install --access host-root
```

Existing installs and installs without `--access host-root` remain isolated.

## Architecture and interface

`config.json` gains:

```json
{
  "schemaVersion": 3,
  "accessMode": "isolated"
}
```

Allowed values are:

- `isolated`: current behavior; only explicitly registered workspaces are
  mounted.
- `host-root`: Linux-only, explicit owner opt-in. The host root filesystem is
  mounted at `/host`, read-only in `spaceapp-core` and read/write in
  `spaceapp-cli`. The CLI entrypoint keeps its current unprivileged UID in
  isolated mode and runs CLI sessions as container root only in host-root
  mode.

The launcher writes a generated `compose.host-access.yml` and includes it in
every Compose command. It must never mount the Docker socket. It must not add
host PID, network, IPC, or device namespaces in this increment.

The launcher accepts:

```text
install [--profile auto|light|standard]
        [--access isolated|host-root]
        [--no-open]
```

Omitting `--access` preserves an existing installation's mode and selects
`isolated` for a new installation. Changing back with `--access isolated`
removes the host-root mount on the next recreated `up`.

## Linux distribution strategy

There is one Linux implementation, not one SpaceApp build per distribution.
Only Docker prerequisite adapters differ:

- `apt`: Ubuntu and Debian (current).
- `dnf`: Fedora, RHEL, and CentOS (current).
- `pacman`: Arch and derivatives whose `ID` or `ID_LIKE` identifies the Arch
  family, including CachyOS (new).

If Docker Engine and Compose are already ready, the launcher remains
distribution-independent and skips package-manager detection.

There is no authoritative global denominator or SpaceApp telemetry for Linux
distribution share, so the project must not publish a fabricated exact
percentage. The evidence-backed coverage statements are:

- Runtime path: all modern Linux installations where Node.js 20.11+, Docker
  Engine, and Compose v2 already work on `amd64` or `arm64`.
- Automatic prerequisite path before this change: only exact Ubuntu, Debian,
  Fedora, RHEL, and CentOS IDs.
- Automatic prerequisite path after this change: the above plus the Arch
  family through `pacman`, including CachyOS.

Directional planning estimates may be described as ranges, not measured
facts: the current exact-ID bootstrap likely covers roughly 60-80% of
mainstream server installations and 45-65% of desktop installations; adding
Arch-family support materially improves desktop coverage. These ranges are not
release acceptance evidence.

## Threat model

### Assets

- Every file on the host root filesystem.
- Boot configuration, package database, user credentials, SSH keys, browser
  profiles, and application data.
- The integrity and availability of the Linux installation.

### Trust boundaries

- The one authenticated SpaceApp owner is trusted.
- Repository content, agent instructions, provider output, and upstream CLI
  output remain untrusted.
- Container root with a writable `/host` bind mount is equivalent to host-root
  file access on a normal rootful Docker Engine.

### Required controls

- Host-root is opt-in and Linux-only.
- The launcher prints a prominent warning and the exact access transition.
- Default and migrated installations are isolated.
- Core receives a read-only mount; only CLI receives a writable mount.
- No Docker socket, host PID namespace, host network namespace, or
  `privileged: true`.
- Generated configuration contains no secrets.
- Documentation states that host-root can destroy the OS or disclose any host
  credential and should be used only by one trusted owner.

### Out of scope for this increment

- Protection from a malicious or compromised provider CLI.
- Per-command approval or filesystem policy inside host-root mode.
- Passwordless `sudo` configuration.
- Direct control of host processes or devices.
- A non-Docker/native SpaceApp distribution.

## Project structure

```text
packages/run-spaceapp/src/index.mjs
  Config schema, access-mode migration, generated Compose override.
packages/run-spaceapp/src/cli.mjs
  Additive install flag, Linux-only validation, warnings and transitions.
packages/run-spaceapp/src/prerequisites.mjs
  Arch-family detection and pacman Docker installation.
packages/run-spaceapp/tests/
  Contract, migration, Compose and prerequisite regression tests.
deploy/docker/cli-entrypoint.sh
  Root execution only when the explicit host-root environment flag is true.
docs/
  Security model, getting started and personal prerelease instructions.
```

## Code style

Use existing dependency-free ESM helpers and explicit validation:

```js
export function resolveInstallAccessMode(requestedMode, existingMode = "isolated") {
  if (requestedMode === undefined) return existingMode;
  if (requestedMode === "isolated" || requestedMode === "host-root") return requestedMode;
  throw new Error("Install access mode must be isolated or host-root.");
}
```

Do not construct package-manager commands through shell strings. Continue to
use structured `{ command, args }` execution specifications.

## Commands

Focused tests:

```sh
npm test -w run-spaceapp -- config.test.mjs cli.test.mjs prerequisites.test.mjs
```

Launcher package:

```sh
npm run check -w run-spaceapp
npm pack --dry-run -w run-spaceapp
```

Repository checks before prerelease:

```sh
npm test
npm run check
npm run build
npm audit --audit-level=high
```

## Testing strategy

- Unit tests prove schema migration, default isolation, access flag parsing,
  generated Compose mounts, and rollback to isolated mode.
- Prerequisite tests prove CachyOS/Arch routing uses fixed pacman arguments and
  existing apt/dnf behavior remains unchanged.
- CLI tests prove non-Linux host-root requests fail before Docker or file
  mutation, output reports the access transition, and failed activation restores
  the previous isolated runtime or stops a failed clean install.
- Compose contract tests prove the Docker socket and privileged/host namespace
  settings are absent.
- An isolated CachyOS VM must prove real install, `/host` read/write behavior,
  a controlled file create/delete under a temporary host directory, readiness,
  and removal of the mount after switching back to isolated mode.

## Boundaries

- Always: preserve `isolated` as the default; use structured commands; test
  migration and downgrade; keep secrets out of config and logs.
- Ask first: publish or promote npm/GHCR artifacts; change public `latest`;
  add host namespaces, Docker socket, devices, or passwordless sudo.
- Never: enable host-root implicitly; run host-root on Windows/macOS; expose
  the web application beyond loopback as part of this change; touch
  `VM207:/srv/space` or `spaceapp.dev`.

## Success criteria

1. One prerelease command installs on CachyOS when the owner explicitly selects
   host-root access.
2. CLI sessions can read and modify a controlled host file through `/host`.
3. New and migrated installs remain isolated unless explicitly changed.
4. Switching to `--access isolated` removes the root bind mount without
   deleting SpaceApp data, credentials, workspaces, secrets, or volumes.
5. Existing Ubuntu/Debian/Fedora/RHEL/CentOS launcher tests remain green.
6. No Docker socket, privileged container, host namespace, or secret is added.
7. The same npm package and image set serves all supported Linux families.
