# Narration and music

## Narration

The narration is the description of the video, spoken. A requester may give it (`options.narration.text`); else write it from
the brief and the transcript: what is shown, why it matters, in short sentences a listener follows. Keep it shorter than the
output: about 2.5 words per second.

Engines (`space_video_formats` lists the languages; Kokoro and Chatterbox are local, pinned under the tools dir):

| Engine | Languages | Notes |
|---|---|---|
| `kokoro` | en, es, fr, hi, it, pt, ja, zh | Fast, 54 voices (`af_heart` default, `am_adam`, `bf_emma`, …) |
| `chatterbox` | 23 incl. el (Greek), de, ar, ru, tr, pl, nl, sv, da, fi, no, ko, ms, sw, he | Slower; voice cloning from a sample; an optional install |
| `murf` | el, en, es, fr, de, it, pt, hi, ja, zh, ko, nl, pl, hr, sk, bn, ta | Cloud Gen2 voices; Greek is `el-GR-stavros` (male, the only Greek voice). Voice ids are `<locale>-<name>` (`en-US-natalie`, `en-UK-hazel`, `de-DE-josephine`); a Kokoro id or none takes the language's default, a voice of another language speaks this one. Paid per character from the Murf API credits (Gen2 about $0.03 per 1,000 characters, a 60 s voice-over about $0.03; credits expire 3 Feb 2027) |
| `livekit` | every language but sw | LiveKit Inference (startup grant): Cartesia Sonic 3 through LiveKit; a Cartesia voice UUID or Sonic's default |
| `cartesia` | every language but sw | Cartesia Sonic 3 with its own key; a Cartesia voice UUID or the default |
| `fish` | en, zh, ja, de, fr, es, ko, ar, ru, nl, it, pl, pt | Fish Audio S1; a 32-hex Fish voice model id (cloned voices) or Fish's default |

A cloud engine whose key is not installed answers `TTS_ENGINE_MISSING`; Setup → Tools shows which cloud voice keys are present.
`space_video_transcribe` takes `engine`: `whisper` (local, the default), `assemblyai`, `cartesia` or `livekit` (Deepgram Nova 3); the same
words file comes back, and a missing key answers `STT_ENGINE_MISSING`.

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
