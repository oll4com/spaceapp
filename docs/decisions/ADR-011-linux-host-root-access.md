# ADR-011: Add explicit Linux host-root access to the Docker distribution

## Status

Accepted for personal prerelease

## Date

2026-07-27

## Context

One trusted owner needs SpaceApp CLI sessions to inspect and modify their
complete CachyOS/Linux installation. Maintaining a native SpaceApp build per
Linux distribution would duplicate the application, release, and test surface.
The existing Docker distribution already provides a common runtime on
`linux/amd64` and `linux/arm64`.

The default public security contract mounts only explicitly registered
workspaces and runs the CLI host as an unprivileged container user. Any broader
mode must remain visible, reversible, and opt-in.

## Decision

Keep one SpaceApp distribution and add `--access isolated|host-root` to the
launcher.

- `isolated` remains the default for new and migrated installations.
- `host-root` is Linux-only and must be selected explicitly.
- The host root is mounted at `/host`, read-only in core and read/write in CLI.
- The CLI host runs as container root only when the generated environment flag
  is exactly `true`.
- The Docker socket, privileged mode, host namespaces, devices, and
  passwordless `sudo` remain excluded.
- Arch-family prerequisite installation uses fixed `pacman` arguments,
  including CachyOS through `ID`/`ID_LIKE` detection.
- The first release uses npm tag `personal` and does not change `latest`.

## Alternatives considered

### Separate native package per Linux distribution

Rejected because the SpaceApp runtime itself is distribution-independent once
Docker Engine and Compose v2 are available. Only prerequisite package-manager
commands differ.

### Mount the Docker socket

Rejected because it grants broad daemon control, including arbitrary container
creation and host mounts, beyond the requested filesystem access.

### Use `privileged: true` or host namespaces

Rejected because direct process, device, and namespace authority is not
required to edit host files and would materially expand the attack surface.

### Enable host-root automatically on Linux

Rejected because writable host-root access can disclose credentials, corrupt
the package database, delete user data, or make the operating system
unbootable.

## Consequences

The same npm package and images serve all supported Linux families, while the
owner gets the requested full filesystem access through `/host`. The mode is
not a sandbox and does not protect the host from malicious repository content,
provider output, or mistaken agent commands.

Switching back to `--access isolated` removes the root bind mount on container
recreation and preserves SpaceApp configuration, credentials, workspaces,
secrets, backups, and persistent volumes.
