---
name: space-hyperframes
description: HyperFrames (heygen-com/hyperframes, CLI 0.8.156) for video written as HTML - compositions, animation, captions, audio, keyframes, slideshows, motion graphics, product launch, PR, music and faceless explainer videos and Remotion migration - rendered to MP4 with the pinned hyperframes CLI, the host's Chrome and ffmpeg. Use when the operator asks for a video, an animation or a motion piece.
metadata:
  category: WORKFLOW
---

# HyperFrames

Start with [hyperframes/SKILL.md](hyperframes/SKILL.md): it runs the intent interview, picks the route and sends you to the specialist skills next to it (`hyperframes-core`, `hyperframes-animation`, `hyperframes-creative`, `hyperframes-cli`, `embedded-captions`, `media-use`, ...). A citation such as `/hyperframes-core` → `references/<name>.md` means `hyperframes-core/references/<name>.md` in this folder.

## In Space

Repository and operator instructions (`AGENTS.md`, `/etc/AGENTS.md`) take precedence over these skills.

- **CLI.** Run `hyperframes <command>`: the pinned 0.8.156 wrapper `~/.local/bin/hyperframes` keeps telemetry, update checks, self-install and skill mirroring into CLI homes off, and renders with `/usr/bin/google-chrome` and `/usr/bin/ffmpeg`. Wherever a skill or a scaffolded project says `npx hyperframes ...`, `npx --yes hyperframes@...` or `npm run dev|check|render|publish`, run `hyperframes ...` instead, because npx downloads its own copy outside the wrapper. If `hyperframes --version` does not print `0.8.156`, stop and tell the operator.
- **Needs consent.** `hyperframes upgrade`, `skills`, `usage` (it reads the Claude and Codex credential files), `telemetry enable`, `feedback`, `auth`, `publish`, `cloud`, `lambda` and `cloudrun`; installing optional local models (whisper.cpp, Kokoro, MusicGen through pip) or a browser (`@puppeteer/browsers install`); and cloud providers (HeyGen, Gemini, ElevenLabs, ...) for TTS, transcription, images or vision, which use the operator's own keys. Never ask for or print keys.
- **Rendering.** This host renders in screenshot mode (no chrome-headless-shell): normal compositions are fine, heavy ones are slower. Iterate with `-q draft`. Stop any `preview` or studio server you started when you finish.
- **Where files go.** Projects, renders and caches go to `/var/lib/spaceapp-user/agent-workspace/active/YYYYMMDD-HHMM-<topic>/`; never commit them. Publish an MP4 to Agent Files only when the user explicitly asks for the file.

Source and license: [UPSTREAM.md](UPSTREAM.md).
