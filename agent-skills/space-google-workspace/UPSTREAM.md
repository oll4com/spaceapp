# Upstream

- Repository: https://github.com/googleworkspace/cli
- Commit: `a3768d0e82ad83cca2da97724e46bea4ff0e6dbd` (main, 2026-03-31); the skills carry `metadata.version: 0.22.5`, the same as the installed binary
- Files: every file of `skills/` (95 skills: `gws-*` services and helpers, `recipe-*`, `persona-*`), copied unchanged into this folder. The repository `LICENSE` is copied to this folder.
- Not vendored: the Rust source (`crates/`), the npm launcher (`npm/`), docs, the Gemini extension and the demo media.

Space changes: none to the vendored files. This folder's index `SKILL.md`, `LICENSE` and this file are new.

## Binary on the Space host

- Release `v0.22.5`, asset `google-workspace-cli-x86_64-unknown-linux-gnu.tar.gz`, sha256 `de78ecdbd2f1a84cca0063a7ecbc440240fc14b6ebccbb17f4646b792a8c5c1f` (the GitHub release digest, the `.sha256` sidecar and the downloaded file agreed on 2026-10-14). The extracted `gws` has sha256 `ab59c4bab4e7848740ba8cc3ef186152dab90121c45835b49bd1bf2a5c259b86`.
- Installed for the operator account at `~/.local/lib/gws/0.22.5/gws`, linked as `~/.local/bin/gws`, which is on every CLI pane's `PATH`. The pane host mounts `/usr` read-only (`ProtectSystem=strict`), so it is not under `/usr/local` like the impeccable engine.
- When a re-vendor changes the skills' `metadata.version`, install the matching release the same way (verify both checksums) before deploying.

## License

Licensed under the Apache License, Version 2.0; the full text is in [LICENSE](LICENSE). Copyright Google LLC and the googleworkspace/cli contributors (https://github.com/googleworkspace/cli). Not an officially supported Google product.
