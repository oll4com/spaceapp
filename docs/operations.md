# Operations

SpaceApp uses versioned Compose images and persistent Docker volumes. Run
launcher commands as the same host user and with the same `SPACEAPP_HOME` used
during installation.

## Routine status and logs

```bash
spaceapp doctor
spaceapp status
spaceapp logs
```

`doctor` checks local resources, Docker CLI, Compose, and engine readiness.
`status` reports Compose service state. `logs` returns the current bounded
Compose log tail; inspect it before restarting a failing service.

Stop or start the application without deleting data:

```bash
spaceapp down
spaceapp up
```

## Backup

```bash
spaceapp backup
```

Each backup is stored below the installation's `backups` directory and
contains:

- `database.dump`: PostgreSQL custom-format dump;
- `data.tar.gz`: application data, excluding mutable memory and browser
  profiles;
- `memory.tar.gz`: mutable owner memory;
- `manifest.json`: format metadata, sizes, and SHA-256 checksums.

Backups do **not** contain provider API-key files, OAuth/device login state,
the provider-state Docker volume, registered host workspace contents, or
browser profiles. Store credentials in a password manager and keep independent
backups of the source repositories themselves.

Backup directories and files are owner-restricted. They can still contain
private room/application content and owner memory, so protect them as sensitive
data.

## Restore

```bash
spaceapp restore
```

The launcher:

1. requires an explicit `RESTORE` confirmation;
2. selects the newest valid portable backup;
3. creates a fresh pre-restore backup;
4. stops the core, CLI, and browser services;
5. validates the selected manifest, checksums, archive paths, and format;
6. replaces application data, memory, and PostgreSQL state;
7. starts the application again.

Restore is destructive to current application data. Make an offline copy of
the installation's `backups` directory before a disaster-recovery exercise.
Provider login state is not restored; reconnect providers when moving to a new
Docker host.

## Update

Before updating:

```bash
spaceapp backup
spaceapp doctor
```

Update the launcher with `sudo npm install -g run-spaceapp` on Linux when Node
uses a system-wide npm prefix, or `npm install -g run-spaceapp` on macOS and
Windows.

Then select the exact target release:

```bash
spaceapp update 0.1.7
spaceapp status
```

An update records one previous version, pulls the corresponding core, CLI, and
browser images, and recreates the stack while preserving volumes.

Do not use an important application as the first test of a new release. Run
the update and backup/restore sequence in the dedicated clean-room environment
first.

## Rollback

If the new release fails its health or owner workflow checks:

```bash
spaceapp rollback
spaceapp status
```

Rollback returns to the single previously recorded image version. It does not
reverse database or data-format changes by itself. If a release migration is
not backward-compatible, follow that release's notes and restore the
pre-update backup.

## Owner password

```bash
spaceapp owner reset-password
```

The new password is read from masked input and must be at least 12 characters.
It is sent through standard input to the running core container and is not
placed in the command line.

## Uninstall

Remove containers and the Compose network while keeping configuration, backup
files, secrets, and Docker volumes:

```bash
spaceapp uninstall
```

Remove containers and Docker volumes only after an explicit confirmation:

```bash
spaceapp uninstall --purge-data
```

`--purge-data` is destructive to application, database, memory, provider
state, and workspace-volume data. Host files below `SPACEAPP_HOME`, including
backups and provider key files, remain and must be reviewed separately.

## Exposure and reverse proxies

The default loopback bind is the supported single-owner posture. If an owner
changes the bind address or adds a reverse proxy, they are responsible for TLS,
access policy, trusted proxy configuration, firewall rules, updates, backup
retention, and log retention. Do not bind an instance directly to an untrusted
network.
