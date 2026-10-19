# Operations

SpaceApp uses versioned Compose images and persistent Docker volumes. Run
launcher commands as the same host user and with the same `SPACEAPP_HOME` used
during installation.

## Routine status and logs

```bash
npx --yes run-spaceapp@latest doctor
npx --yes run-spaceapp@latest status
npx --yes run-spaceapp@latest logs
```

`doctor` checks local resources, Docker CLI, Compose, and engine readiness.
`status` reports Compose service state. `logs` returns the current bounded
Compose log tail; inspect it before restarting a failing service.

Stop or start the application without deleting data:

```bash
npx --yes run-spaceapp@latest down
npx --yes run-spaceapp@latest up
```

## Backup

```bash
npx --yes run-spaceapp@latest backup
```

Each backup is stored below the installation's `backups` directory and
contains:

- `database.dump`: PostgreSQL custom-format dump;
- `data.tar.gz`: application data, excluding mutable memory and browser
  profiles;
- `memory.tar.gz`: mutable owner memory;
- `manifest.json`: format metadata, sizes, and SHA-256 checksums;
- `spaceapp-config.json`: the installation settings, including the registered
  workspace list (no secrets);
- `cli-config.tar.gz`: the CLIs' own settings: Claude Code `settings.json` and
  `.claude.json`, Codex `config.toml`, OpenCode `opencode.json` (MCP servers,
  base URLs, models). Login files and API keys are not included.
- `users/<user>-cli-config.tar.gz` and `users/<user>-memory.tar.gz` (team
  accounts only): each user's CLI settings and Space Memory from their own CLI
  container. Their logins and keys are not included.

Backups do **not** contain provider API-key files, OAuth/device login state,
the provider-state Docker volume, registered host workspace contents, browser
profiles, the Google OAuth client (`google-oauth.json`) or the Telegram bot
secrets. A restore keeps the ones already on the host. Store credentials in a password manager and keep independent
backups of the source repositories themselves.

Backup directories and files are owner-restricted. They can still contain
private room/application content and owner memory, so protect them as sensitive
data.

## Restore

```bash
npx --yes run-spaceapp@latest restore
```

The launcher:

1. requires an explicit `RESTORE` confirmation;
2. selects the newest valid portable backup;
3. creates a fresh pre-restore backup;
4. stops the core, CLI, and browser services;
5. validates the selected manifest, checksums, archive paths, and format;
6. replaces application data, memory, and PostgreSQL state;
7. starts the application again;
8. puts the CLI settings of the backup back and lists the backup's workspaces
   that are not registered on this host, with the `workspace add` command for
   each.

Restore is destructive to current application data. Make an offline copy of
the installation's `backups` directory before a disaster-recovery exercise.
Provider login state is not restored; reconnect providers when moving to a new
Docker host. On a new host, also enter the Google OAuth client and the Telegram
bot token again. Stored secrets are encrypted with the installation's session
secret, which a new host does not share: database connection passwords report
`CREDENTIAL_UNREADABLE` until you enter them again, and connected accounts ask
you to reconnect.

## Update

The universal install command is also the preferred update command. It resolves
the latest launcher, records the previously installed SpaceApp version, preserves
the existing profile, checks additional space, pulls the matching images, and recreates the
stack without deleting application data, workspaces, credentials, secrets, or
persistent Docker volumes.

Before changing versions, the launcher pauses application writers and verifies
a checkpoint of the database, configuration, and secrets. If startup or
readiness fails after cutover, it stops application writers, retains the current
database and all volumes, and reports `RECOVERY_REQUIRED`. It never automatically
replaces current data with an older checkpoint: the new runtime may already
have accepted owner changes. Run `doctor --fix` to repair the attempted version.
Use an explicit restore only after deciding how to preserve any newer changes.

Before updating:

```bash
npx --yes run-spaceapp@latest backup
npx --yes run-spaceapp@latest doctor
```

Then run the same universal command used for a clean installation:

```bash
npx --yes run-spaceapp@latest install
npx --yes run-spaceapp@latest status
```

An update keeps the installed profile. To change it, pass the profile
explicitly, for example to add the managed browser:

```bash
npx --yes run-spaceapp@latest install --profile large
```

Installing a global launcher with `npm install -g run-spaceapp` remains
optional. The universal examples do not depend on that global installation.

Do not use an important application as the first test of a new release. Run
the update and backup/restore sequence in the dedicated clean-room environment
first.

## Linux access mode

Host-root access is Linux-only and meant for a disposable, trusted
single-owner machine; see the [security model](security-model.md):

```bash
npx --yes run-spaceapp@latest install --access host-root
```

To remove the `/host` mount without deleting SpaceApp state or volumes:

```bash
npx --yes run-spaceapp@latest install --access isolated
```

Installation profiles do not change the access mode.

## Rollback

If the new release fails its health or owner workflow checks:

```bash
npx --yes run-spaceapp@latest rollback
npx --yes run-spaceapp@latest status
```

Rollback returns to the single previously recorded image version. It does not
reverse database or data-format changes by itself. If a release migration is
not backward-compatible, follow that release's notes and restore the
pre-update backup.

## Owner password

```bash
npx --yes run-spaceapp@latest owner reset-password
```

The new password is read from masked input and must be at least 6 characters.
It is sent through standard input to the running core container and is not
placed in the command line.

## Uninstall

Remove containers and the Compose network while keeping configuration, backup
files, secrets, and Docker volumes:

```bash
npx --yes run-spaceapp@latest uninstall
```

The command reports progress and is safe to repeat. It does not remove the
global launcher package. Remove that separately with
`npm uninstall -g run-spaceapp` only after the runtime result is successful.

Remove containers and Docker volumes only after an explicit confirmation:

```bash
npx --yes run-spaceapp@latest uninstall --purge-data
```

`--purge-data` is destructive to application, database, memory, provider
state, and workspace-volume data. Host files below `SPACEAPP_HOME`, including
backups and provider key files, remain and must be reviewed separately.

## Team accounts

An owner can give other people their own SpaceApp account. Each user's CLIs run
in a CLI container of their own, with their own keys, logins, Space Memory and
workspaces; the owner's keys and repositories never reach it. Accounts need the
isolated access mode.

```bash
npx --yes run-spaceapp@latest user enable                      # turn accounts on
# invite the person in Settings -> Users; they set a password from the link
npx --yes run-spaceapp@latest user add <user-id> [--memory 2g] # their CLI container
npx --yes run-spaceapp@latest credentials set <provider> --user <user-id>
npx --yes run-spaceapp@latest workspace add <path> --user <user-id>
npx --yes run-spaceapp@latest provider install <provider> --user <user-id>
npx --yes run-spaceapp@latest user list
npx --yes run-spaceapp@latest user remove <user-id>            # volumes are kept
```

`user add` waits until the user's CLI container answers. A user sees only their
own rooms and the rooms shared with them; the owner shares a room from the
Rooms dock (View or Collaborate). A backup keeps each user's CLI settings and
Space Memory. After `restore` on a new installation, run the `user enable`,
`user add` and `workspace add --user` commands it prints, enter the users' keys
again, then `user restore <user-id>` puts each user's settings and memory back.

## Exposure and reverse proxies

The default loopback bind is the supported single-owner posture. If an owner
changes the bind address or adds a reverse proxy, they are responsible for TLS,
access policy, trusted proxy configuration, firewall rules, updates, backup
retention, and log retention. Do not bind an instance directly to an untrusted
network.

## Optional modules

Modules beyond the coding workspace run only when enabled: `games`,
`job-copilot`, `mail-copilot`, `marketing-copilot`, `channels` (Slack and
Teams), `telegram`, `waitlist` and `desktop-updates`. Installations created with
1.1.5 or later start with none of them (`"optionalModules": "none"` in the
launcher's `config.json`); an installation upgraded from an earlier version has
no such field and keeps all of them. To change the set, edit the field (`all`,
`none` or a comma-separated list such as `job-copilot,games`) and run:

```bash
npx --yes run-spaceapp@latest repair
```

A module that is off registers no routes, starts no background work and is
hidden in the web app.
