# Media Studio: views, sizes and targets

These lists are the allowlists in `scripts/space-media-capture.mjs`; nothing outside them is accepted.

## Viewports (`--viewport a,b,c`, at most 8)

| Preset | CSS size | Scale | Output pixels | Layout |
|---|---|---|---|---|
| `desktop` | 1440x900 | 2 | 2880x1800 | desktop |
| `desktop-hd` | 1920x1080 | 1 | 1920x1080 | desktop |
| `laptop` | 1280x800 | 2 | 2560x1600 | desktop |
| `tablet` | 820x1180 | 2 | 1640x2360 | tablet (touch) |
| `tablet-landscape` | 1180x820 | 2 | 2360x1640 | tablet (touch) |
| `mobile` | 390x844 | 3 | 1170x2532 | mobile (touch) |
| `android` | 412x915 | 2.625 | 1082x2402 | mobile (touch) |
| `og` | 1200x630 | 1 | 1200x630 | desktop |
| `square` | 1080x1080 | 1 | 1080x1080 | desktop |
| `portrait` | 864x1080 | 1.25 | 1080x1350 | tablet |
| `story` | 360x640 | 3 | 1080x1920 | mobile (touch) |
| `x` | 1280x720 | 1.25 | 1600x900 | desktop |
| `linkedin` | 1200x627 | 1 | 1200x627 | desktop |
| `ph-gallery` | 1270x760 | 1 | 1270x760 | desktop |
| `yt-thumb` | 1280x720 | 1 | 1280x720 | desktop |

`space_screenshot` (Space Control) takes the device presets plus `square`, `portrait` and `story`, or an `aspect`:
`16:9` = `desktop-hd`, `1:1` = `square`, `4:5` = `portrait`, `9:16` = `story` (phone layout), `full` = `desktop`.
`maxWidth`/`maxHeight` lower the scale to fit.

## Frames (`--frame`, with `--headline` up to 120 and `--subline` up to 200 characters)

`og` 1200x630, `square` 1080x1080, `portrait` 1080x1350, `story` 1080x1920: the shot in a rounded window with a shadow
over the SpaceApp night gradient, headline above it. Each shot gets `shot-<viewport>-frame-<frame>.png` next to it.

## Docks (`--dock`)

`rooms`, `notifications`, `room-agent`, `shared-chat` (Council), `media`, `streaming`, `source-control`, `agent-files`,
`clipboard`, `tasks`, `links`, `settings`, `health`, `cli`, `agent-sessions`.

## Settings sections (`--settings`)

`appearance`, `docks`, `panes`, `widgets`, `notifications`, `dots`, `plugins`, `agent-capabilities`, `default-provider`,
`voice-input`, `releases`, `cli-pane-controls`, `date-time`, `image-previews`, `prompt-variables`, `room-cache`,
`git-worktrees`, `diagnostics`, `job-copilot`, `mail-copilot`, `marketing-copilot`, `freelance-copilot`.
Account & Google, Backup & migration, GitHub & Gitea and Telegram are left out: they show credentials.

## Health sections (`--health`)

`overview`, `topology`, `performance`, `processes`, `services`, `ai` (AI & Sessions), `alerts`, `usage` (Token usage).

## Mock showcase scenes (`--instance mock --scene <chapter>:<step>`)

| Chapter | Steps |
|---|---|
| `rooms` | 0 Build, 1 Research, 2 Create, 3 Remote, 4 Back to Build |
| `panes` | 0 Choose your tools, 1 Your coding agents, 2 More agent runtimes, 3 Research tools, 4 Create & talk, 5 Remote tools |
| `layouts` | 0-5 (fail in the deployed mock) |
| `docks` | 0-4 (fail in the deployed mock) |

With `--scene` the mock loads in showcase mode (Motion theme). Without it you get the plain mock workspace.

## Appearance values

| Flag | Account key | Values |
|---|---|---|
| `--theme` | `uiTheme` | modern, classic, codex (Graphite), motion, aurora, liquid-glass |
| `--mode` | `modernAppearance` | system, light, dark (Modern theme only) |
| `--icons` | `modernIconPack` | space (Space Duotone), lucide, material-rounded, motion, aurora |
| `--background` | `uiBackground` | spaceapp, aurora, liquid-glass (Glass Planet), none |
| `--tint` | `liquidGlassTint` | 0-100 |
| `--room-theme` | `roomTheme` | graphite, forest, copper, steel, contrast, motion |
| `--zoom` | `uiZoom` | 50-200 |
| `--unmasked` | `sensitiveDataMasked` | off (masking is on by default) |
