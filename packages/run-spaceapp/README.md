# run-spaceapp

Cross-platform Docker launcher for the SpaceApp public alpha.

> The package is not published yet. The command below is the intended
> installation path after the first alpha release.

```bash
npm install --global run-spaceapp@alpha
spaceapp init
spaceapp doctor
spaceapp workspace add /absolute/path/to/a/project
spaceapp up
spaceapp open
```

The launcher requires Node.js 20.11 or newer and Docker Compose. It stores only
non-secret configuration in the current user's platform config directory:

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
