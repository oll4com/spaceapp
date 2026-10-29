# Techniques

`space_video_analyze` finds the cuts; you choose the clips. Its result always has `shots` (scene boundaries from ffmpeg's
`scdet`), and per technique:

| Technique | What it finds | How to cut |
|---|---|---|
| `silence` | `silences` (gaps below `silenceDb`, default −30 dB, at least `minSilenceSec`) and `speech`, the complement: the segments to keep. auto-editor when installed, else ffmpeg `silencedetect`. | One clip per `speech` segment, in order; the engine joins them with the transition. The classic "cut the dead air" edit. |
| `scene` | `scenes` from PySceneDetect (`sceneThreshold`, default 27). | One clip per scene you keep; drop the ones that add nothing. |
| `highlights` | `candidates`: segments of 8–45 s ranked by words per second, loudness peaks and scene alignment, each with its text. Needs `wordsPath` from `space_video_transcribe`. | Read the candidates' text against the brief, pick the moments that tell the story, order them (the strongest first for a Short), trim each to its sentence boundaries using the words' times. |
| `manual` | Nothing beyond `shots`. | The requester or you name the exact in/out times. |

Reframe (for a 9:16 or 1:1 output from a landscape source): `FACE` follows the face track (`reframe` in the analysis: one
crop centre per shot, never interpolated across a cut), `CENTER` crops the middle, `OFF` letterboxes the source on a blurred
copy of itself.

## The timeline

```json
{
  "version": 1,
  "clips": [{ "sourceIndex": 0, "inSec": 12.4, "outSec": 31.0 }, { "sourceIndex": 0, "inSec": 58.2, "outSec": 70.5, "speed": 1.25 }],
  "transition": "auto", "transitionSec": 0.4,
  "filter": "none", "reframe": "FACE",
  "captions": { "style": "karaoke", "language": null, "position": "BOTTOM" },
  "overlays": [{ "artifactId": "artifact:…", "fromSec": 0, "toSec": 3, "position": "full" }],
  "narration": { "engine": "kokoro", "voice": "af_heart", "language": "en", "segments": [{ "atSec": 0, "text": "…" }], "volumeDb": 0 },
  "music": { "artifactId": "artifact:…", "volumeDb": -18, "duckDb": -12, "fadeOutSec": 2 },
  "outputs": [{ "formatId": "youtube-short" }, { "formatId": "square", "label": "Instagram" }],
  "maxDurationSec": 60
}
```

- `sourceIndex` counts the request's sources (or `sourceArtifactIds` as you passed them). Up to 200 clips, 8 outputs, 20 overlays.
- `transition`: `auto` = a 0.4 s fade between clips from different sources, a hard cut inside one source; `cut` = hard cuts
  everywhere; or one ffmpeg `xfade` name (`fade`, `dissolve`, `fadeblack`, `fadewhite`, `wipeleft`, `wiperight`, `slideup`,
  `slidedown`, `circleopen`, `smoothleft`, `zoomin`) for every join.
- `filter`: `none`, `warm`, `cool`, `vivid`, `cinematic`, `bw`, `stabilize` (two-pass, slow).
- `speed` 0.25–4 per clip (1.25–1.5 tightens a slow explanation; the audio keeps its pitch).
- The engine enforces each output's longest duration (the format's, or `maxDurationSec` when shorter): a Short is at most 180 s,
  a Reel 90 s, an X video 140 s, a YouTube video 60 minutes.
