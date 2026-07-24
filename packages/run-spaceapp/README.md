# run-spaceapp

Cross-platform Docker launcher for SpaceApp.

Linux:

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

The launcher requires Node.js 20.11 or newer, 4 CPUs, 8 GB RAM, and 15 GiB free
disk. If Docker is missing, `spaceapp install` automatically installs it from
official Docker sources on Windows, macOS, Ubuntu, Debian, Fedora, RHEL, and
CentOS, starts it, and waits for Engine and Compose readiness before pulling
images. Windows prefers Windows Package Manager's hash-pinned Docker Desktop
manifest and retains a signed direct-download fallback. Docker Desktop license
acceptance and Linux `docker` group membership require confirmation inside the
same command. On Windows, approve any UAC prompt required by WSL2 or Docker
Desktop. If Windows requests one restart, rerun the same command afterward and
installation continues safely.

The launcher selects the `light` profile below 12 GiB RAM and the `standard`
profile otherwise; override this with `--profile light` or
`--profile standard`.

Light mode retains every bundled CLI and the core data/workflow services while
omitting managed Chromium. Resource limits are maximums, not immediate RAM or
disk reservations. The launcher stores only non-secret configuration in the
current user's platform config directory:

- Linux: `$XDG_CONFIG_HOME/spaceapp` or `$HOME/.config/spaceapp`
- macOS: `$HOME/Library/Application Support/SpaceApp`
- Windows: `%APPDATA%\SpaceApp`

Set `SPACEAPP_HOME` to an absolute path to use a dedicated installation root.

Provider API keys are read from masked standard input and written to
restrictive files outside Git. OAuth and device-code credentials remain in
isolated Docker provider state. Neither credential source is included in
portable SpaceApp backups.

Claude Code is not redistributed in SpaceApp images. Install the reviewed
package as an explicit owner action with:

```bash
spaceapp provider install claude
```

Run `spaceapp help` for the complete command list. Full documentation:

- [Getting started](https://github.com/oll4com/spaceapp/blob/main/docs/getting-started.md)
- [CLI providers](https://github.com/oll4com/spaceapp/blob/main/docs/cli-providers.md)
- [Operations](https://github.com/oll4com/spaceapp/blob/main/docs/operations.md)
- [Security model](https://github.com/oll4com/spaceapp/blob/main/docs/security-model.md)
