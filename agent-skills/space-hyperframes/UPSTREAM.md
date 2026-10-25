# Upstream

- Repository: https://github.com/heygen-com/hyperframes
- Commit: `d9edffa3a4e766cb97e7beb09efb2682b6ace5fc` (main, 2026-10-14); `packages/cli` version 0.8.156, the same as the installed CLI
- Files: every file of `skills/` (21 skills with their references, scripts, fonts, sound effects and template assets, plus the upstream `python-encoding.test.mjs`), copied unchanged into this folder. The bundled fonts keep their OFL texts. The repository `LICENSE` is copied to this folder.
- Not vendored: the packages (`packages/`), `skills-manifest.json`, docs, examples, registry, themes and the per-harness plugin folders.

Space changes: none to the vendored files. This folder's index `SKILL.md`, `LICENSE` and this file are new.

## CLI on the Space host

- npm `hyperframes@0.8.156` (integrity `sha512-p2oI0wr5q+OtWJMdsEfBQdfita57FU92loJ3H2FDYL+aDEd96VAQ7mGMDyR6llW5YyV9kPWoneS7SX8b02Wztw==`), installed on 2026-10-14 with `npm install -g --prefix ~/.local/lib/hyperframes/0.8.156 --ignore-scripts hyperframes@0.8.156` for the operator account.
- `~/.local/bin/hyperframes` is a wrapper that exports `HYPERFRAMES_NO_TELEMETRY=1`, `DO_NOT_TRACK=1`, `HYPERFRAMES_NO_UPDATE_CHECK=1`, `HYPERFRAMES_NO_AUTO_INSTALL=1`, `HYPERFRAMES_SKIP_SKILLS=1` and a default `HYPERFRAMES_BROWSER_PATH=/usr/bin/google-chrome` before running it. The pane host mounts `/usr` read-only (`ProtectSystem=strict`), so it is not under `/usr/local`.
- `hyperframes doctor` passes for Node, Chrome, FFmpeg and FFprobe; a blank composition rendered a 10-second 1080p H.264 MP4. Transcription, local TTS and music models are not installed.
- When a re-vendor changes the CLI version, install the matching version the same way and update the wrapper path before deploying.

## License

Licensed under the Apache License, Version 2.0; the full text is in [LICENSE](LICENSE). Copyright 2026 HeyGen, Inc.
