# Contributing to SpaceApp

Thank you for helping improve SpaceApp. The project is in alpha, so public
interfaces may change while we make installation and self-hosting reliable.

## Before opening a change

- Use GitHub Discussions for design questions and issues for reproducible bugs.
- Never submit credentials, personal memory, customer data, private hostnames,
  private IP addresses, or machine-specific paths.
- Keep the single-owner self-hosted security model intact unless an accepted
  design proposal explicitly changes it.
- Large architecture or public API changes should include an ADR in
  `docs/decisions/`.

## Development

Requirements are Node.js 22 and npm. Docker is required for runtime and
clean-install integration tests.

```bash
npm ci
npm run check
npm test
npm run build
```

Run `npm run hygiene:preflight` before committing. Add or update tests for
behavior changes. UI changes also require real browser verification with no
new console or network failures.

## Pull requests

Keep pull requests focused and explain:

1. the problem and user impact;
2. the chosen design and alternatives;
3. tests and operating systems verified;
4. security, migration, and rollback considerations.

By submitting a contribution, you agree that it is licensed under Apache
License 2.0 and that you have the right to submit it.
