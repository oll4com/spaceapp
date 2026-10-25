# Upstream

- Repository: https://github.com/pbakaus/impeccable
- Commit: `919dbeba520df760a157fe635be62faae88d58da` (main, 2026-10-12); skill version 4.5.2, engine 0.1.14
- Files: every file of `.agents/skills/impeccable/` (the generic Agent Skills build: `SKILL.md`, `reference/`, `agents/`, `scripts/`), copied unchanged into `impeccable/` (the launcher `scripts/impeccable` keeps its executable mode). The repository `LICENSE` is copied to this folder.
- Not vendored: the other per-harness copies (`.claude/`, `.cursor/`, `plugin/`, ...), the source tree (`skill/`, `crates/`), tests and the website.

Space changes: none to the vendored files. This folder's index `SKILL.md`, `LICENSE` and this file are new.

## Engine on the Space host

- Release `engine-v0.1.14`, asset `impeccable-linux-x64`, sha256 `3d31ec1a664ac35c815ea1d7c10abad1155ce364d0f461157eb837a34368efb6` (the GitHub release digest, the `.sha256` sidecar and the downloaded file agreed on 2026-10-12).
- Installed at `/usr/local/lib/impeccable/0.1.14/impeccable` (root, 0755). `/usr/local/bin/impeccable` is a wrapper that exports `IMPECCABLE_NO_TELEMETRY=1`, `DO_NOT_TRACK=1` and `IMPECCABLE_NO_UPDATE_CHECK=1` before running it.
- When a re-vendor changes `impeccable/scripts/VERSION`, install the matching engine the same way (verify both checksums) before deploying, or the launcher will try to download it.

## License

Licensed under the Apache License, Version 2.0; the full text is in [LICENSE](LICENSE). Copyright the impeccable authors (https://github.com/pbakaus/impeccable).
