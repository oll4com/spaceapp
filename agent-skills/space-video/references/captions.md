# Captions

Captions come from the words of `space_video_transcribe` (`wordsPath`), re-timed to the timeline by the engine, burned into the
picture inside the format's safe area as ASS subtitles.

| Style | Look | Use |
|---|---|---|
| `karaoke` | Three or four words per line, the spoken word highlighted as it is said | Shorts, Reels, TikTok |
| `bold-center` | One short line of up to four words, large and centred | Punchy explainers |
| `lower-third` | A band at the bottom, a sentence at a time | YouTube, LinkedIn, talks |
| `none` | No captions | When the brief says none |

`language`: null keeps the transcript's language; set it when the transcript detected the wrong one (then transcribe again
with `language`). `position`: `BOTTOM` (default) or `TOP` when the lower safe area is covered by the network.

Check the captions on the output's frames: readable on a phone, inside the safe area, no word cut off, the right language.
Fix a wrong word by editing `words.json` (a copy next to it, then pass that path as `wordsPath`), never the transcript model.
