# Narration and music

## Narration

The narration is the description of the video, spoken. A requester may give it (`options.narration.text`); else write it from
the brief and the transcript: what is shown, why it matters, in short sentences a listener follows. Keep it shorter than the
output: about 2.5 words per second.

Engines (local, pinned under the tools dir; `space_video_formats` lists the languages):

| Engine | Languages | Notes |
|---|---|---|
| `kokoro` | en, es, fr, hi, it, pt, ja, zh | Fast, 54 voices (`af_heart` default, `am_adam`, `bf_emma`, …) |
| `chatterbox` | 23 incl. el (Greek), de, ar, ru, tr, pl, nl, sv, da, fi, no, ko, ms, sw, he | Slower; voice cloning from a sample |

Hear it first: `space_video_tts` makes a NARRATION asset (`space_video_asset_file` gives the WAV); then put the text in the
timeline's `narration.segments` and the engine speaks it during assembly (one voice-over from 0 s). `volumeDb` nudges it.

## Music

Sources, in this order:

1. The operator's library: `space_video_assets` with `kind: MUSIC` (tracks the operator uploaded in the Music tab, or ones
   fetched before). Use their `credits` as they are.
2. CC BY tracks: `space_video_music_search` (a mood or style: "calm piano", "upbeat electronic") lists ccMixter tracks with
   `url`, `license` and `attribution`; `space_video_music_fetch` downloads one into the library with its credits.
3. None when the brief says no music, or for talks where music would fight the voice.

In the timeline, `music.volumeDb` (default −18 dB) sets the level and `music.duckDb` (default −12 dB) how far it drops under
speech and narration (0 turns ducking off); the engine loops or trims it to the output and fades it out (`fadeOutSec`). The
whole mix is normalized to −16 LUFS.

Credits: every output that uses a CC BY track carries its attribution in `credits`; the delivery message repeats it, and the
requester must show it where the video is published. Never use music from any other source.
