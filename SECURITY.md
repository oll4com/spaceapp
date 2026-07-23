# Security Policy

## Supported versions

SpaceApp is pre-release software. Security fixes are provided only for the
latest published alpha release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use the repository's
private **Security** → **Report a vulnerability** flow:

https://github.com/oll4com/spaceapp/security/advisories/new

Include the affected version, impact, reproduction steps, and any suggested
mitigation. Do not include real credentials, personal memory, or private
workspace contents. Maintainers will acknowledge a complete report within
seven days and will coordinate disclosure after a fix is available.

## Security model

- SpaceApp is designed for one owner on one self-hosted instance.
- It is not a multi-tenant authorization boundary.
- The default web bind is loopback-only.
- Telemetry is disabled by default.
- Secrets belong in Docker-managed volumes or local files with restrictive
  permissions; they must never be committed to Git or stored in launcher
  configuration.
- Provider CLI authentication is governed by each provider's own terms and
  credential storage.

See `docs/security-model.md` for deployment boundaries and threat assumptions.
