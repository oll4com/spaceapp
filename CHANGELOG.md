# Changelog

Notable user-facing changes are documented here. This project follows
Semantic Versioning.

## [Unreleased]

## [0.1.3] - 2026-07-24

- complete headless Linux installation successfully when no native browser
  opener is installed, while printing the local SpaceApp URL for manual use.

## [0.1.2] - 2026-07-24

- accept nominal 8 GB hosts whose guest operating system reports slightly
  less than 8 GiB;
- report the optional browser host as disabled in the light profile so
  readiness and container health become green without starting Chromium.

## [0.1.0] - 2026-07-23

Initial public release:

- single-owner, self-hosted Agent Room application;
- one-command Docker installation for Linux, macOS, and Windows 11/WSL2;
- `run-spaceapp` npm launcher with automatic `light` and `standard` profiles;
- supported 8 GB light profile with bounded service resources;
- pinned multi-architecture core, browser, and CLI container images;
- isolated provider credentials and generic starter memory;
- sanitized clean-history public source export and release gates;
- portable backup, restore, update, and rollback commands;
- no telemetry by default.

[Unreleased]: https://github.com/oll4com/spaceapp/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.3
[0.1.2]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.2
[0.1.0]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.0
