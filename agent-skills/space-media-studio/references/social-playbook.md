# Media Studio: social playbook

## Sizes per platform

| Platform / use | Direct render (`--viewport`) | Framed card (`--frame`) |
|---|---|---|
| Link preview, blog, dev.to cover | `og` | `og` |
| X post image | `x` | `og` |
| LinkedIn post | `linkedin` | `og` or `square` |
| Instagram / LinkedIn square | `square` | `square` |
| Instagram feed (4:5) | `portrait` | `portrait` |
| Stories, Reels, Shorts, TikTok | `story` | `story` |
| Product Hunt gallery | `ph-gallery` | `og` |
| YouTube thumbnail | `yt-thumb` | `og` |
| Docs, README, store listing | `desktop`, `tablet`, `mobile` | none |

A direct render shows the real app at that size (story uses the mobile layout). A framed card puts a crisp `desktop`
or `mobile` shot inside the card with a headline: usually the better choice for a feed post.

## Recipes

```bash
# Launch post set from one Studio room: framed cards for X/LinkedIn and a story
node /opt/spaceapp/scripts/space-media-capture.mjs --instance dev --slug launch --room room:<studio> \
  --viewport desktop --frame og --headline "Run every coding agent side by side" --subline "SpaceApp, self-hosted"
node /opt/spaceapp/scripts/space-media-capture.mjs --instance dev --slug launch-story --room room:<studio> \
  --viewport story --theme aurora --mode dark

# One pane up close (a CLI at work)
node /opt/spaceapp/scripts/space-media-capture.mjs --instance dev --slug codex-pane --room room:<studio> \
  --pane pane:<id> --crop pane --viewport desktop

# Theme comparison: one shot per theme, same room
for t in modern codex aurora liquid-glass; do
  node /opt/spaceapp/scripts/space-media-capture.mjs --instance dev --slug theme-$t --room room:<studio> --viewport laptop --theme $t --mode dark
done
```

## Video scenarios

```json
{"steps":[
  {"dwellMs":2000},
  {"dock":"room-agent","dwellMs":3000},
  {"settings":"appearance","dwellMs":3000},
  {"health":"usage","dwellMs":4000}
]}
```

Mock tour (no private data):

```json
{"steps":[{"scene":"rooms:0","dwellMs":3000},{"scene":"rooms:1","dwellMs":3000},{"scene":"panes:1","dwellMs":3500},{"scene":"rooms:3","dwellMs":3000}]}
```

Then, for a finished piece, load `space-hyperframes`: put the MP4 clips in a composition with captions, music, an
intro card and the right aspect ratio (1080x1920, 1080x1080 or 1920x1080), and render the final MP4.

## Hand-off

- Marketing Copilot: give the operator (or the copilot's brief) the file paths; a post carries them as `assets`
  (images and videos, at most 10 per post) and the copilot uploads them in its pane browser.
- Agent Files: only when the operator asks, with `space-publish-file <path>` for the final files only.
- Report to the operator: the folder, the files with their sizes, what was skipped, and which instance and commit
  (`manifest.json`) the shots show.
