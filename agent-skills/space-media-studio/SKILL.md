---
name: space-media-studio
description: "Media Studio: screenshots and short videos of SpaceApp for social posts, docs and store listings, from stable, dev or the public demo mock, in desktop, tablet, mobile and social sizes (og, square, portrait, story, X, LinkedIn, Product Hunt, YouTube), with a capture-only theme and colour preview, framed social cards and a Studio room the agent arranges through Space Control. Use when the operator asks for screenshots, product shots, social images or a video of the app, or to change how the app looks for a shot."
metadata:
  category: WORKFLOW
---

# Media Studio (SpaceApp screenshots and video)

Media Studio produces pictures and clips of SpaceApp itself: any room, pane, dock, Settings or Health section, in
device and social sizes, with any theme and colours, and short scripted tours as MP4/GIF. It has three parts:

- the capture engine `node /opt/spaceapp/scripts/space-media-capture.mjs` (stills, social frames, video);
- `node /opt/spaceapp/scripts/space-admin-action.mjs` to read or change the operator's appearance and to build and
  arrange a Studio room through Space Control (`control ...`);
- the Space Control tool `space_screenshot` (Dots: `space.screenshot`), which uses the same engine for one room shot
  saved in that room's Media.

Allowlists and every flag value: `references/views-and-targets.md`. Sizes per platform, frames and video recipes:
`references/social-playbook.md`.

## Rules

1. **Session.** The engine takes a session from the root-owned auth broker inside its own process. Never ask for, print,
   save or pass a password, cookie or token.
2. **The operator's live rooms are read-only.** They open only under the broker's `MEDIA_CAPTURE` scope (READ_ONLY): CLI
   terminals attach as observers, a stopped CLI is never started, and the capture browser fails every API write.
   Without that scope the engine refuses every room except an Agent Proof room. Never try to get around the refusal.
3. **Changes happen only in a Studio room** (an Agent Proof room you create). Open, arrange, prompt and close panes
   there, never in the operator's rooms. Delete the Studio room when the task ends, also on failure.
4. **Appearance is a preview by default.** `--theme`, `--mode`, `--icons`, `--background`, `--tint`, `--room-theme` and
   `--zoom` change only what the capture browser shows; the account stays as it is. Change the account itself only when
   the operator asks, and record the old values first (see "Persistent appearance").
5. **Privacy.** Masking (`sensitiveDataMasked`) is on unless the operator asks for `--unmasked`. Masking does not hide
   task, clipboard, chat or terminal text: shots meant for publishing come from the Studio room or the mock, or from
   views the operator approved. Look at every image before you hand it over.
6. **Delivery.** Output stays in `~/agent-workspace/active/<date>-media-<slug>/`. Publish to Agent Files
   (`space-publish-file`) only when the operator asks for it. Never publish to a social network from this skill: that
   is the Marketing Copilot's job.

## Quick start

```bash
# Rooms you may capture (ids and names)
node /opt/spaceapp/scripts/space-admin-action.mjs rooms-list

# One room on dev, three sizes, Tasks dock open, Aurora dark preview
node /opt/spaceapp/scripts/space-media-capture.mjs --instance dev --slug launch --room room:<id> \
  --viewport desktop,tablet,mobile --dock tasks --theme aurora --mode dark

# A clean public shot: the demo mock (no account, no private data), framed as a 1080x1080 card
node /opt/spaceapp/scripts/space-media-capture.mjs --instance mock --slug tour --scene rooms:1 --viewport desktop \
  --frame square --headline "Every coding agent, one room" --subline "SpaceApp"

# A 15-second tour as MP4 and GIF
node /opt/spaceapp/scripts/space-media-capture.mjs --instance dev --slug tour --room room:<id> --viewport laptop \
  --video /var/lib/spaceapp-user/agent-workspace/active/<task>/scenario.json --gif
```

The engine prints a JSON report and writes `manifest.json` next to the files: instance, commit, session mode
(`read-only`, `studio` or `public-mock`), target, appearance, every file with its size and sha256, `skipped` steps the
page could not show, and `blockedWrites` (writes the capture browser stopped).

## Instances and sessions

| `--instance` | Opens | Session |
|---|---|---|
| `stable` | the operator's instance (`127.0.0.1:4911`) | broker; read-only scope for live rooms |
| `dev` | http://127.0.0.1:4911:4940 (copy of stable's data) | broker, dev's own cookie |
| `mock` | the public demo at https://spaceapp.dev/spaceappmock/ | none (local demo data) |

- The `MEDIA_CAPTURE` scope ships with the broker in stable's deploy. Until the operator promotes it, the engine answers
  "This broker has no read-only scope yet": capture in a Studio room, or use the mock.
- A Studio room (`--room` of an Agent Proof room) is always shot with a full `studio` session: the page lists only that
  room, its terminals attach as a normal client sized to the shot (a read-only observer keeps each CLI's own width, so
  Claude Code and Gemini render garbled), and every request naming another room is refused, because the page would
  otherwise follow the operator when they switch rooms in their own browser. Still look at every frame before handing
  a clip over.
- Dev runs no browser host (browser panes show `BROWSER_SESSIONS_DISABLED`) and at most 2 CLIs.
- Read-only sessions get no Dots, voice or Live history answers, so those panes look emptier there.

## Targets

- `--room room:<id>`: the room to show. `--pane <id>`: select a pane; add `--crop pane` for just that pane.
- `--dock <id>`: open a dock (`--crop dock` crops to it). `--settings <key>`: open the Settings dock at a section.
  `--health <section>`: open the Health dock at a section (`usage` is Token usage).
- `--view app|help|benchmark`. On the mock, `--scene <chapter>:<step>` runs one showcase scene.
- `--format png|jpeg|webp`, `--quality 1-100`.

## Appearance

Preview (account untouched): `--theme modern|classic|codex|motion|aurora|liquid-glass|jarvis|aira` (`codex` is shown as
Graphite), `--mode system|light|dark` (only the Modern theme has a light mode), `--icons lucide|material-rounded|motion|aurora|space`,
`--background spaceapp|aurora|liquid-glass|jarvis|aira|none`, `--tint 0-100` (Glass Planet), `--room-theme graphite|forest|copper|steel|contrast|motion`,
`--zoom 50-200`.

### Persistent appearance (only on the operator's request)

```bash
node /opt/spaceapp/scripts/space-admin-action.mjs user-appearance-get            # record these values first
node /opt/spaceapp/scripts/space-admin-action.mjs user-appearance '{"uiTheme":"aurora","roomTheme":"copper"}'
node /opt/spaceapp/scripts/space-admin-action.mjs user-appearance '<the recorded values>'   # restore when asked
```

Keys: `uiTheme`, `modernAppearance`, `modernIconPack`, `uiBackground`, `liquidGlassTint`, `roomTheme`, `uiZoom`,
`sensitiveDataMasked`. Prefix any action with `SPACE_ADMIN_INSTANCE=dev` to run it on dev.

## Studio room (a set you build)

```bash
node /opt/spaceapp/scripts/space-admin-action.mjs proof-room-create "SpaceApp Studio" panes=0      # -> room:<studio>
node /opt/spaceapp/scripts/space-admin-action.mjs control space_describe_pane_types '{"roomId":"room:<studio>"}'
node /opt/spaceapp/scripts/space-admin-action.mjs control space_execute '{"roomId":"room:<studio>","requestId":"studio-1",
  "actions":[{"kind":"resource","operation":"panes.open","input":{"terminalRuntimeId":"cli:codex"}}]}'
node /opt/spaceapp/scripts/space-admin-action.mjs control space_execute '{"roomId":"room:<studio>","requestId":"studio-2",
  "actions":[{"kind":"pane","operation":"color","target":{"paneIds":["pane:<id>"],"state":"ALL"},"color":"blue","when":"NOW"},
             {"kind":"layout","operation":"sort"}]}'
# ... capture with --room room:<studio> ...
node /opt/spaceapp/scripts/space-admin-action.mjs proof-room-delete room:<studio>
```

In a Studio room `control` also allows pane `maximize`, `minimize`, `restore`, `color`, layout `sort`, `apply`, `tree`,
`prompt` (to give a CLI something real to show) and `space_screenshot`. `control` needs `SPACE_ROOM_ID` (it runs inside a
Space pane). Close every pane and the room you opened.

## Video

A scenario file is `{"steps":[...]}` with 1-20 steps and at most 180 seconds; each step may hold `dock`, `settings`,
`health` (or `scene` on the mock) and `dwellMs` (500-30000, default 3000). The engine records device-pixel frames and
encodes a 30 fps H.264 MP4 (`--gif` adds a GIF). One room per clip: record several clips for a multi-room tour and join
them with the `space-hyperframes` skill, which also adds captions, music and motion.

## Space Control `space_screenshot`

CLI agents (Space Control MCP, their own room) and Dots (`space.screenshot`, their own room, photos only) call
`space_screenshot`; the Room Agent does not have it. The API captures the room read-only as the caller and saves the
result in the room's Media (kept 7 days; a Marketing Copilot post that attaches it keeps it).

- Size: `aspect` = `16:9` (1920x1080), `1:1` (1080x1080), `4:5` (1080x1350), `9:16` (1080x1920, the phone layout) or
  `full` (the desktop window), the social ratios of the desktop titlebar menu; or `viewport` = desktop, desktop-hd,
  laptop, tablet, tablet-landscape, mobile, android, square, portrait or story (`viewport` wins).
- What is shown: `paneId` (selected), `dock`, `settings` or `health` (the lists above); `crop` = `pane` or `dock` cuts
  a photo to it.
- Photo: `format`, `quality`, `maxWidth`, `maxHeight`; a SCREENSHOT artifact.
- Video: `video: {"steps":[{dock?, settings?, health?, dwellMs}]}` (1-20 steps, at most 180 s, never cropped) records
  an MP4 into a VIDEO artifact. It answers RUNNING with an `operationId`; read `space_operations
  {"operation":"get","id":"<operationId>"}` until COMPLETED, whose result holds the `artifactId` and the real
  `durationMs` (opening a dock or section between steps adds to the dwell time).
- Every result lists under `skipped` the docks or sections it could not open: retry or change the step.

From a CLI in a Studio room:
`node /opt/spaceapp/scripts/space-admin-action.mjs control space_screenshot '{"roomId":"room:<studio>","aspect":"9:16","dock":"tasks","video":{"steps":[{"dwellMs":5000},{"settings":"appearance","dwellMs":5000}]}}'`
then `control space_operations '{"roomId":"room:<studio>","operation":"get","id":"<operationId>"}'`. The Live voice pane
keeps its own screen-share path.

## Known limits

- Mock scenes: `rooms:*` and `panes:*` work; `layouts:*` and `docks:*` fail inside the deployed mock ("workspace control
  is not ready"). Use the app's own docks on dev or in a Studio room instead.
- A dock that is hidden by the operator's Docks settings cannot be opened; the report lists it under `skipped`.
- Social presets render the real layout at that size (story uses the mobile layout); use `--frame` for a marketing card
  around a desktop shot.
