# Changelog

Notable user-facing changes are documented here. This project follows
Semantic Versioning.

## [Unreleased]

## [0.1.11] - 2026-07-26

- make `npx --yes run-spaceapp install` the same one-command installer on
  Linux, macOS, and Windows 11 Command Prompt;
- expose a package-name-matching `run-spaceapp` executable so npm can resolve
  the launcher reliably through `npx`;
- default automatic installs to the supported 8 GB light profile on every
  host while retaining the standard browser profile as an explicit opt-in;
- synchronize an existing installation to the installed launcher and image
  version on a repeated `install`, preserving data, credentials, secrets, and
  the previous version for rollback;
- detect the clean-Windows WSL2 reboot boundary, register a one-time pinned
  installer resume, and continue automatically after the user signs back in;
- document the Windows restricted-PowerShell interception and direct users to
  the Command Prompt profile where the universal command works unchanged.

## [0.1.10] - 2026-07-26

- hide the browser-heavy 150–250 GB dedicated-storage warning when the
  automatic 8 GB light profile has browser sessions disabled;
- retain the dedicated-storage readiness warning for the standard profile,
  where managed browser sessions are enabled.

## [0.1.9] - 2026-07-25

- make `spaceapp open` degrade cleanly on headless systems by printing the
  exact manual URL and returning success when the native browser opener is
  unavailable;
- supersede the unpromoted `0.1.8` candidate after clean-room acceptance
  exposed the missing-opener contract gap.

## [0.1.8] - 2026-07-25

- wait for application readiness before reporting installation success or
  opening the browser;
- issue and print a fresh database-accepted first-owner token at the end of
  every successful unclaimed installation, with exact paste and recovery
  instructions;
- discover Docker Desktop's trusted CLI directory on every Windows and macOS
  launcher invocation, including `doctor`, `status`, and `uninstall`;
- distinguish missing Docker CLI/Compose from a stopped engine and make Docker
  exit `127` visible for every runtime command;
- report uninstall progress, retained state, repeat-safe success, volume purge
  results, and the separate global npm removal command;
- add command contracts for every entry exposed by `spaceapp help` and
  supersede the unpromoted `0.1.7` candidate.

## [0.1.6] - 2026-07-24

- fix Windows one-command setup by preferring the hash-pinned
  `Docker.DockerDesktop` Windows Package Manager manifest;
- retain the official Docker direct download with Authenticode verification as
  a fallback when Windows Package Manager is unavailable.

## [0.1.5] - 2026-07-24

- fix release verification for compact multi-platform OCI attestations so
  large browser SBOMs no longer exceed the verifier process buffer;
- remove CodeQL command, JavaScript, and redirect injection paths;
- prove global and per-route API rate-limit ordering with runtime regression
  coverage;
- update React, React DOM, Lucide, Vite, and release workflow actions while
  preserving immutable full-SHA action pins;
- keep TypeScript 5.9 until the TypeScript 7 compiler API is stable enough for
  the release security tests.

## [0.1.4] - 2026-07-24

- install and start signed Docker Desktop automatically on Windows and macOS
  when it is missing, with explicit license confirmation;
- elevate WSL2 setup through the Windows UAC prompt and stop safely for a
  required restart before downloading Docker Desktop;
- install Docker Engine, Buildx, and Compose automatically from official
  Docker repositories on Ubuntu, Debian, Fedora, RHEL, and CentOS;
- require a ready Docker engine before pulling SpaceApp images and safely
  continue Linux installation through newly granted `docker` group membership;
- pin the Node 22.23.0 multi-architecture base image by OCI digest and install
  the fixed Debian `liblzma5` package in every image stage;
- update Temporal and MCP HTTP dependencies to reviewed security releases;
- prevent container privilege escalation with `no-new-privileges`;
- block fixable Medium, High, and Critical findings while preserving complete
  weekly Trivy evidence for upstream-unfixed vulnerabilities;
- publish protected GHCR and npm artifacts through a manual, main-only OIDC
  workflow with SBOM, provenance, immutable-tag preflight, and no npm token.

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

[Unreleased]: https://github.com/oll4com/spaceapp/compare/v0.1.11...HEAD
[0.1.11]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.11
[0.1.10]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.10
[0.1.9]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.9
[0.1.8]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.8
[0.1.6]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.6
[0.1.5]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.5
[0.1.4]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.4
[0.1.3]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.3
[0.1.2]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.2
[0.1.0]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.0
