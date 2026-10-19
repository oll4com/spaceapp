# SpaceApp security model

SpaceApp's security boundary is one trusted owner operating one
self-hosted instance. It does not provide tenant isolation, team roles, or a
SaaS control plane.

## Trust boundaries

- The owner controls the host, Docker installation, selected workspaces, and
  provider accounts.
- Browser clients are untrusted until the owner setup or session flow
  authenticates them.
- Workspace files and repository content are untrusted input. Adding a
  workspace grants the selected CLI tools access to that path.
- Provider CLIs and their upstream services are independent third parties with
  their own licenses, privacy policies, and credential formats.
- Container images and npm artifacts are software-supply-chain inputs. SpaceApp's
  own images are built, scanned and published by the public release workflow,
  which verifies their SBOM and provenance attestations; the launcher pulls them
  by exact version tag. Third-party images (PostgreSQL, Temporal, codex-lb,
  headroom) are pinned by digest in the compose template.

## Default protections

- The web application binds to `127.0.0.1:4911` unless the owner deliberately
  changes the bind address.
- First launch uses a one-time, hashed, expiring setup token. There is no
  production default password or development login.
- An expired unclaimed setup token can be rotated only through a local,
  fixed-argument container command. The database update is conditional on the
  owner still being unclaimed.
- The launcher configuration contains only non-secret settings.
- OAuth/device credentials remain in per-provider volumes. API keys are read
  from masked standard input and written to restrictive local secret files;
  they are not passed in command arguments, logs, or application database rows.
- Only the CLI service mounts imported provider keys and provider state. The
  application core mounts neither and communicates with CLI runtimes through a
  protected Unix socket.
- Portable backups intentionally exclude provider API-key files, provider
  login state, registered host workspace contents, and browser profiles.
- Host workspaces are not mounted until the owner runs
  `npx --yes run-spaceapp@latest workspace add`.
- Containers do not receive the Docker socket.
- The CLI container runs with `no-new-privileges`. Where the host allows
  unprivileged user namespaces (Docker Desktop on Windows and macOS, most Linux
  hosts), it also gets Docker's default seccomp profile plus user namespaces
  (`seccomp-cli.json`) and no AppArmor profile, so Codex can sandbox each
  command with bubblewrap; this gives the agent's code more kernel interfaces
  than Docker's defaults. Where the host restricts them (Ubuntu 23.10 and later:
  `kernel.apparmor_restrict_unprivileged_userns=1`) the sandbox could not run,
  so the container keeps Docker's defaults and Codex asks before each command.
- Telemetry is disabled by default.
- Mutable owner memory is separate from the immutable generic starter memory.

## Explicit Linux host-root mode

`npx --yes run-spaceapp@latest install --access host-root` enables this
mode. It mounts the host `/` at `/host`, read-only in `spaceapp-core` and
read/write in `spaceapp-cli`, and runs CLI sessions as container root. With a
normal rootful Docker Engine, this is equivalent to host-root file access.

This mode can disclose every host credential, overwrite boot and package
configuration, delete user data, or destroy the operating system. Repository
instructions, model output, and provider CLI output remain untrusted even when
the one SpaceApp owner is trusted. There is no per-command approval or
filesystem policy inside this mode.

Host-root is Linux-only, disabled by default, and never selected by a resource
profile. New and migrated installations use `isolated`; omitting `--access`
preserves the existing choice. Run
`npx --yes run-spaceapp@latest install --access isolated` to remove the host
root mount without deleting application data or persistent volumes.

The host-root override does not mount the Docker socket and does not enable
`privileged`, host PID, host network, host IPC, devices, or passwordless
`sudo`. These controls limit additional container authority but do not reduce
the read/write `/host` mount to a sandbox.

## Network exposure

Loopback binding protects only against direct network access. Owners who expose
SpaceApp through a reverse proxy are responsible for TLS, proxy access policy,
firewall rules, updates, backups, and log retention. Self-hosted installations
should not be placed directly on the public Internet.

## Out of scope

- malicious or compromised host administrators;
- isolation between multiple mutually untrusted users;
- arbitrary untrusted plugin execution;
- protection from a provider CLI that is itself compromised;
- credential portability or provider-account recovery;
- availability guarantees or managed disaster recovery.

Report suspected vulnerabilities using the private process in
[`SECURITY.md`](../SECURITY.md).
