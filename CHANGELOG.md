# Changelog

Notable user-facing changes are documented here. This project follows
Semantic Versioning.

## [Unreleased]

## [1.1.7] - 2026-10-21

Source: sanitized Space app @ 7619ef9523 (4729 files: SpaceApp 77d00f6895 with
the reviewed fixes of the 1.1.7 internal review). Moves SpaceApp and the
launcher to the MIT License, makes OpenCode 2 the first CLI, and ships the
remaining fixes from the independent reviews; open items are listed in
`docs/quality/KNOWN_LIMITATIONS.md`.

### Licence

- SpaceApp and the run-spaceapp launcher are released under the MIT License
  from 1.1.7 (Copyright (c) 2026 INTRATRADE SINGLE MEMBER P.C.). Published
  versions keep their licence: v0.1.3 to v1.0.2 Apache-2.0, v1.0.31 to 1.1.6
  BSL 1.1; the launcher was Apache-2.0 up to 1.1.6.
- The licence texts of third-party code inside SpaceApp (Material Symbols,
  Headroom, unidiff-rs, the tree-sitter grammars, codex-lb, caveman, ponytail)
  ship in `THIRD_PARTY_LICENSES/` in the repository and in every image, and
  `THIRD_PARTY_NOTICES.md` lists them.

### OpenCode 2

- OpenCode 2 (`@opencode/cli` 2.0.32) is the first CLI. Its panes attach to one
  shared OpenCode server per CLI container, started once and restarted by the
  next pane when it stopped or its keys or configuration changed; every other
  OpenCode command runs `--standalone`, so no per-user background service
  starts.
- The core container no longer runs OpenCode or checks a CLI login itself:
  those calls go to the CLI container's credential agent, each with fixed
  inputs and size and time limits. Text-mode OpenCode answers there may only
  read files.
- The first-launch free-model check retries the model catalog after a server
  error, a timeout or a lost connection (three tries).
- After a CLI container restart the shared server's helper no longer stops
  whatever process took the old server's process number; it stops only its own
  `opencode serve`.
- OpenCode's own update check is off: the image pins OpenCode and run-spaceapp
  releases update it (its update dialog took a new pane's first prompt).

### Security and integrity

- SpaceApp's own images are pulled by the digest the release records in the
  npm package, including the CLI containers of team accounts.
- Docker's Linux repository keys are trusted only when the downloaded key file
  holds Docker's published key and no other primary key. On Fedora, RHEL and
  CentOS the launcher writes Docker's repository file itself, with that checked
  key as the only key (Docker's own repository file is no longer downloaded), so
  `dnf` accepts only packages signed with it. The Cursor agent download is
  pinned by checksum.
- Desktop Google sign-in hands the session only to the desktop app that started
  it: the browser returns a one-time code to the app's own loopback address and
  the app redeems it with a secret it kept (RFC 8252 with PKCE). A sign-in link
  started by someone else no longer gives them the session. Desktop builds older
  than this need an update to sign in with Google; password sign-in is
  unchanged.
- A secrets folder that already existed is made owner-only by `install`,
  `update`, `up` and `repair`.
- Six vulnerability-scan exceptions that no longer matched anything were
  removed.

### Backup and restore

- `backup` pauses the core, CLI, browser and Temporal containers and also saves
  the Temporal databases, so the database, files, memory and workflow history
  are one moment; the backup's workspace list and CLI settings follow.
- `restore` stages the files, saves a copy of the current databases and then
  restores each database of the backup in its own transaction, swapping the
  files in only after every database restored. If a database or the file swap
  fails, it puts every database and file back as they were before the restore
  and says so (the copy needs free space on the data volume for the databases
  once more). If putting a database back fails too, it keeps the copies, names
  each database left at the backup's state and prints the command that puts it
  back; running the same restore again finishes the restore instead. A backup
  made by 1.1.7 cannot be restored by an older SpaceApp, and it records the
  SpaceApp version it was made with.

### Fixes

- Claude Code installs without npm's `allow-scripts` warning.
- On a public install the room monitor sees a Codex pane's screen and turns
  (the API reads Codex's session logs from their own read-only volume), and
  Codex no longer stops a new pane at its own update prompt.
- With telemetry Yes, `first_answer` is reported when an agent finishes its
  first answer, not only while the agents dashboard is open.
- The launcher tests skip their POSIX-only checks on Windows.

### Also in this release

- Optional modules `app-studio` (build Android and iOS apps with Expo, with
  phone previews) and `design` (graphics that any agent can request); like the
  other optional modules they are off in new installations (enable them with
  `optionalModules` in `config.json` and `spaceapp repair`).
- CLI panes: a local draft field, and prompts that Space types are pasted as
  one block so no CLI keeps them as an unsent draft.
- Large folders no longer slow the Files view; Agent Files are shared by every
  room.

### Known issues

- The provenance check (`scripts/verify-export-provenance.mjs`) verifies the
  files exported from the Space source; the public repository's own files
  (launcher, Dockerfile, workflows) are not listed in the export manifest yet.
  Planned for 1.1.8 (review INT5-C-F9).
- Optional CLIs installed on first use are pinned to exact versions, but their
  own npm dependencies are resolved when they install; per-provider lockfiles
  are planned for 1.1.8 (review INT5-C-F14).

## [1.1.6] - 2026-10-18

Source: sanitized Space app @ f8803d5d96 (4595 files). Adds install telemetry
for owners who opt in and the remaining fixes from the independent reviews of
1.1.5; open items are listed in `docs/quality/KNOWN_LIMITATIONS.md`.

### Pilot rehearsal fixes and team accounts

- Codex sandboxes each command in the CLI container (Docker's default seccomp
  profile plus user namespaces, no AppArmor profile) on Docker Desktop and on
  Linux hosts that allow unprivileged user namespaces. Ubuntu 23.10 and later
  restrict them, so there the container keeps Docker's defaults and Codex still
  asks before each command.
- `restore` prints workspace paths in plain quotes (Windows paths no longer show
  doubled backslashes).
- `workspace add` and `workspace remove` apply at once: they recreate the core
  and CLI services, and say to run `up` when that fails (pilot F1).
- On Linux, `workspace add` checks whether the AI CLIs (uid 10001) can write to
  the folder and, when they cannot, prints the `setfacl` command that gives them
  access without changing its owner (pilot F3).
- OpenCode also gets the Anthropic and OpenAI keys set with
  `credentials set claude` and `credentials set codex` (pilot F4).
- After `credentials set`, a CLI pane starts after one reload: the browser no
  longer keeps an old login state (pilot F5).
- Codex starts on public installs, on its own default model, instead of failing
  with 503 `CLI_CODEX_DEFAULTS_UNRESOLVED` (pilot F6).
- `backup` also saves the launcher configuration with the workspace list
  (`spaceapp-config.json`) and the CLI settings (`cli-config.tar.gz`, mode 0600,
  never logins or keys); `restore` puts the CLI settings back and prints the
  `workspace add` commands to run again (pilot F8).
- `uninstall --purge-data` runs unattended with the answer key `purgeConfirm`
  (pilot F9).
- Claude Code is pinned to 2.1.301 (2.1.206 started API-key users on Opus 4.8)
  (pilot F11).
- Space Memory files use the `space_memory` names; an installation that still
  has `gemini_history*.md` files gets them moved once, with the old names kept
  as links (pilot F13).
- The CLI image includes `python3-minimal` (about 13 MB): agents often check
  their work with a short Python script (pilot F18).
- Team accounts, off until the owner runs `user enable`: each invited user gets
  a CLI container of their own (own keys, logins, Space Memory and workspaces),
  `credentials set`, `workspace add` and `provider install` take `--user`, and
  backups keep each user's CLI settings and Space Memory. See "Team accounts" in
  `docs/operations.md`.

### Telemetry (only after the owner answers Yes)

- The install wizard lists what telemetry sends before it asks; the default is
  still No.
- A Yes gives a new installation a random install ID (in `config.json`, passed
  to SpaceApp as `SPACE_INSTALL_ID`) that links its events: `install_started`
  (OS and version, CPU count, RAM, profile, access mode), then
  `install_completed` or `install_failed` with the step and the duration.
- SpaceApp then reports `setup_completed`, `first_cli` (which CLI started
  first), `first_answer` and at most one `active` event a day with the screen
  size, pixel ratio, browser, UI language and version. The collector derives
  the country from the request and does not store the IP address.
- Installations created by earlier launchers have no install ID and keep
  sending only the events they agreed to.

### Security

- A signed-out session token can no longer be reused: session tokens must have
  exactly two segments, so a revoked token with an extra segment is refused.
- Session revocations fail closed until the saved ones are loaded after a
  restart, and sign-out reports an error when the revocation could not be saved.
- WebSocket handshakes (VNC stream, shared chat, harness) check the Origin.
- Stored database passwords need a full 16-byte authentication tag, and the
  Admin Mode delete guard also compares real paths.
- The app is sent with `frame-ancestors 'self'`, `object-src 'none'` and
  `X-Frame-Options: SAMEORIGIN`.
- Every API child process, including the Space screenshot engine, starts
  through one wrapper that removes the session secret and the database URL
  from its environment.
- CLI sessions create a missing folder only under the managed workspace root
  or where pane creation may (SEC-009).
- Admin Mode saves through a random temporary file and keeps the file mode.
- `/api/worktrees` requires the ADMIN or OPERATOR role, and its errors no
  longer echo raw messages.
- VNC presets come from configuration (`SPACE_VNC_PRESETS`, empty by default).

### Fixes

- `factory-reset` checks the safety backup and the purge: without a backup it
  erases only after `FACTORY-RESET-WITHOUT-BACKUP`, and a failed purge keeps
  the configuration.
- Provider installs and the first OpenCode launch recover from a lock left by
  a killed process instead of failing or waiting 120 s on every start.
- Two workspace folders with the same name get separate container paths.
- Database transactions roll back at every failure site, and `/readyz` keeps
  one pending check per stalled dependency.
- Stopping a busy Codex pane sends the interrupt without waiting for its
  composer.

### Also in this release

- Freelance Copilot pane, Liquid Glass theme, web app manifest and touch icon
  (add SpaceApp to a phone's home screen).
- Phones: a bottom bar to switch panes, panes that end above the keyboard, a
  sticky Ctrl key and key repeat on the on-screen keyboard.
- Browser panes: a tab can use another Google account, Ctrl+V works on
  non-Latin keyboard layouts, and idle operator control returns to the agent.
- Drag a pane onto a room in the Rooms dock to move it there.


## [1.1.5] - 2026-10-15

Source: sanitized Space app @ 2a53fd9793 (4255 files). Addresses the
independent reviews of 1.1.4; open items are listed in
`docs/quality/KNOWN_LIMITATIONS.md`.

### Security

- The API no longer grants credentialed CORS to other local origins, and
  rejects session requests that browser fetch metadata (or the Origin header)
  marks as another site. A page on another `127.0.0.1` port can no longer
  read the CSRF token or use your session.
- `/metrics` answers only loopback scrapers and administrators.
- Child processes (agent CLIs, demo projects, browsers, git) no longer receive
  the session secret or the database URL.
- Stored database passwords use a purpose-bound key; an unreadable password is
  reported instead of being used blank. Backups no longer carry the Google
  OAuth client or Telegram secrets.
- Admin Mode refuses to delete direct children of system roots and the
  workspace with its parents, and every Admin Mode file change is audited.
- Third-party images (PostgreSQL, Temporal, codex-lb) are pinned by digest.

### Changed

- The UI no longer calls SpaceApp open source: it is source-available (BSL)
  until its Change Date, as the LICENSE says.
- **Optional modules:** the games, Job, Mail and Marketing Copilot, Slack/Teams
  channels, Telegram, the waitlist and the desktop update routes run only when
  enabled. New installs start with none of them; an upgraded installation keeps
  all of them. Change the `optionalModules` field of the launcher's
  `config.json` (`all`, `none` or a list such as `job-copilot,games`) and run
  `spaceapp repair` (see `docs/operations.md`).
- A multi-file upload that fails part-way reports which files were saved.
- `npm test` runs every exported workspace suite; the quality evidence
  (`docs/quality/`) ships with the code, and
  `scripts/verify-export-provenance.mjs` checks this tree against its export
  manifest.

### Fixed

- When the first-launch free-model check fails, OpenCode still gets the
  installation instructions and its permission for the memory folder, so the
  first task no longer stops at an "Access external directory" prompt. The
  check runs again on the next launch.
- OpenCode may read `/etc` (read-only in the CLI container, where its startup
  instructions live) without asking; models that read the installation guide
  from there themselves no longer stop the first task at a permission prompt.
- A Claude Code login imported with a configuration bundle also marks Claude
  Code as onboarded, so its pane no longer repeats the first-run login screens.
- A configuration backup exported from a newer SpaceApp now imports what this
  version knows: settings and entries it does not recognise are skipped and
  named in a warning, and a file with a broken structure is still refused.

## [1.1.4] - 2026-10-13

- A CLI pane in a room without a project starts in its own `/workspaces/<room>`
  directory, so a first prompt such as "build me a page" can write files.
- The app shows "Update available: vX" when a newer release exists and opens the
  update command with a Copy button.
- The setup wizard's Ready step offers three first prompts to copy.
- Browser errors are reported to the installation's own API (error name and
  bundle location only) so they appear in its logs.
- Opt-in `first_answer` telemetry: with telemetry Yes, one anonymous event is sent
  the first time an agent finishes an answer (event, random id, version, CPU
  architecture, date). Nothing is sent with telemetry No.
- An explicit `SPACEAPP_TELEMETRY` during a fresh install is now stored with the
  installation, so later updates keep that choice for the `first_answer` event.
- Quieter request logs; `fast-uri` 4 for fastify's JSON serializer.
- The application is updated to the current SpaceApp source (sanitized export of
  aa53bc0a8d). The core image now includes the Space Gateway tree-sitter grammars
  (MIT, listed in THIRD_PARTY_NOTICES.md).

## [1.1.3] - 2026-10-12

- The first OpenCode task no longer stops at a "/tmp" permission prompt: the first
  run authorizes only OpenCode's private scratch directory, and the bootstrap
  instructions send temporary files there. Other paths outside the workspace
  still ask.
- The application is updated to the current SpaceApp source (sanitized export of
  6377b5b491), including guided setup on every screen size and session
  revocations that survive restarts. The gateway's Antigravity sign-in uses an
  owner-supplied OAuth client, as the API already did.
- Contributors: `npm run check` works on a fresh clone, `npm test` runs the
  public test suite, the offline smoke and dependency-boundary check are
  included, and README and CONTRIBUTING link only to files in this repository.


## [1.1.2] - 2026-10-12

- The setup wizard and Help no longer promise the retired DeepSeek V4 Flash model, and the documentation matches the launcher: the Big Pickle starter model with its first-launch check, profile sizes, `@latest` commands, the 12-character owner password, telemetry, and what stays on your machine when a remote model provider is used.
- Check the first-run free OpenCode model with a real tool call: the model must read a small file with its read tool and answer with the random token inside it. Big Pickle is tried first; when it fails, the newest free tool-capable models are tried. Before, a plain text reply was enough, so a model could be chosen that then failed upstream as soon as a task used tools.
- Pin the optional Headroom companion image to a reviewed digest (`headroom-codex-lb:code-5b15319@sha256:491c856a…`) instead of the moving `code` tag, so installs and updates with companions enabled run the same image every time.

## [1.1.1] - 2026-10-11

- Respect the telemetry answer in the install wizard. The first-install ping is now sent only when the owner answers Yes (the default is No) or sets `SPACEAPP_TELEMETRY` to `1`, `true`, `yes` or `on`. Before, the ping was sent unless `SPACEAPP_TELEMETRY` disabled it, whatever the answer.
- Fix fresh installs with the small profile, which 1.0.36 and 1.1.0 rolled back after waiting 10 minutes: readiness again treats the deliberately disabled workflow worker as ready (restores the 1.0.31 fix that a later source export dropped).
- Security: update `@modelcontextprotocol/sdk` to 1.32.1 and pin patched `proxy-addr` 2.0.8 (IP spoofing through IPv4-mapped IPv6 trust subnets), `@fastify/busboy` 3.2.2 (multipart denial of service and header injection), `source-map-js` 1.2.2 and `http-cache-semantics` 4.3.0. Runtime images are rebuilt with these versions.
- Security: runtime images replace npm's bundled `postcss-selector-parser` with 7.1.6 (CVE-2026-104844). GHSA-2mjx-qc3c-rqvc in the rustls copy compiled into `@temporalio/core-bridge` 1.24.0 is ignored until a Temporal SDK release fixes it: SpaceApp reaches Temporal only over the private compose network without TLS.

## [1.1.0] - 2026-10-02

- ship latest sanitized Space app source @ b73eb79ac7 (1133 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.36] - 2026-10-02

- ship latest sanitized Space app source @ 08f2d1adbd (947 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.35] - 2026-10-01

- Apply the candidate Compose template to the installed runtime during updates, after preserving the previous template in the recovery checkpoint. This removes legacy startup overrides from upgraded installations as well as fresh installs.
- Verify upgrades from a legacy Compose template use the new template before starting services and preserve the old template for recovery.

## [1.0.34] - 2026-10-01

- Start the core from its immutable image entrypoint. Remove the legacy startup rewrite of compiled API configuration, which could leave a damaged writable-layer file after a VM restart. Public configuration already disables the agent tools writer.
- Include the upgrade recovery and gRPC security fixes from the unpublished 1.0.32 and 1.0.33 candidates.

## [1.0.33] - 2026-10-01

- Update the shared gRPC dependency to 1.14.5 to resolve certificate authorization and error disclosure advisories rejected by the release audit.
- Include the tested stopped-PostgreSQL and complete update-staging fixes from the unpublished 1.0.32 candidate.

## [1.0.32] - 2026-10-01

- Start and wait for the existing PostgreSQL database before upgrade checkpoints, including when Docker or the database was initially stopped. Preserve existing data and pause application writers before the dump.
- Write the complete temporary Compose configuration before registry image pulls in the update command.
- Add regression coverage for both install-based upgrades and the update command.

## [1.0.31] - 2026-09-30

- Remove dependency JavaScript/CSS source maps from runtime images after compilation to keep AMD64 and ARM64 within the existing image size budgets.

## [1.0.30] - 2026-09-30

- Wait for Temporal's default namespace before starting workflow workers, and restart workflow initialization when enabling a larger profile.
- Remove inactive workflow/browser containers during repair and failed-install recovery while preserving their data volumes.

## [1.0.29] - 2026-09-30

- Make readiness explicitly recognize disabled background workers in the small public profile, while still requiring enabled workers and preserving live/private defaults.

## [1.0.28] - 2026-09-30

- Choose small, medium or large from CPU, RAM and disk, check Docker allocations, and keep existing profiles on upgrades.
- Omit Temporal/background workers and managed Chromium from small; retain legacy profiles and optional providers.
- Check incremental upgrade storage using cached/shared image layers, database checkpoint size and headroom; recheck before cutover without deleting user data.

## [1.0.27] - 2026-09-30

- Wait for the upgraded application to become ready before verifying its checkpoint and reporting success; preserve current data and recovery information if readiness fails.

## [1.0.26] - 2026-09-30

- Make the mocked update contract test independent of any real SpaceApp listener on the test machine.

## [1.0.25] - 2026-09-30

- Allow 2 GiB for the light CLI service so two native OpenCode panes can initialize without exhausting the previous 1536 MiB limit.

## [1.0.24] - 2026-09-30

- Update Temporal SDK to remove the vulnerable native HTTP/3 dependency found by the container scan.

## [1.0.23] - 2026-09-30

- Update the server and bundled npm dependencies to fix the vulnerabilities rejected by the release pipeline.

## [1.0.22] - 2026-09-30

- Reject real Google OAuth credentials while allowing short example placeholders in the settings form.

## [1.0.21] - 2026-09-30

- Require owner-supplied Antigravity OAuth client settings and reject embedded Google OAuth clients in public exports.

## [1.0.20] - 2026-09-30

- Open the installed macOS Docker application by absolute path, report native launch rejection, and allow ten minutes for first engine startup.

## [1.0.19] - 2026-09-30

- Describe verified checkpoints and data-preserving recovery accurately in install and update confirmations.

## [1.0.18] - 2026-09-30

- Finish Linux setup promptly when its browser stays running; keep the opened browser alive and report immediate launch failures.

## [1.0.17] - 2026-09-30

- Load installation instructions and durable memory into OpenCode automatically; authorize only the private memory directory while preserving owner permission policies.
- Explain the free OpenCode first step before optional provider credentials.

## [1.0.16] - 2026-09-30

- Preserve the current database after a partially failed upgrade; retain its verified checkpoint for explicit recovery.
- Open the bundled OpenCode without managed credentials and select a working free model at first launch.

## [1.0.14] - 2026-09-30

- Keep public owner authentication mandatory after setup; preserve this rule on source sync.
- Verify non-empty database checkpoints, pause writers during snapshot, restore secrets and check recovery readiness.
- Start stopped Docker during install/repair; support preloaded images for lab acceptance.
- Install optional provider CLIs on first use and discover a working free OpenCode model.


## [1.0.13] - 2026-09-30

- ship latest sanitized Space app source @ 3fc3d38778 (913 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.12] - 2026-09-30

- ship latest sanitized Space app source @ 3fc3d38778 (880 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.2] - 2026-09-13

- ship latest Space app source from /srv/space @ 6622b05164 (661 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.2] - 2026-09-13

- ship latest Space app source from /srv/space @ 6622b05164 (661 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.1] - 2026-09-13

- ship latest Space app source from /srv/space @ 6c26385c8a (661 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.1] - 2026-09-13

- ship latest Space app source from /srv/space @ 936c1d8ff9 (661 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [1.0.1] - 2026-09-13

- ship latest Space app source from /srv/space @ 36dd7ddb3f (661 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.32] - 2026-09-13

- ship latest Space app source from /srv/space @ 6f92a078b7 (661 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.31] - 2026-09-02

- ship latest Space app source from /srv/space @ bcd800cd99 (523 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.30] - 2026-08-20

- ship latest Space app source from /srv/space @ db2e8d3f07 (520 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.29] - 2026-08-16

- ship latest Space app source from /srv/space @ 04e338fa85 (510 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.28] - 2026-08-15

- ship latest Space app source from /srv/space @ 9a9cb79fa8 (504 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.27] - 2026-08-14

- ship latest Space app source from /srv/space @ e3a625f854 (499 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


- fix(run-spaceapp): wizard answers on non-TTY stdin (Windows npx/PowerShell) are
  read up to the first newline instead of draining the stream to EOF, so the
  "y" confirmation no longer looks frozen and "Please answer y or n." loops are
  gone;
- fix(run-spaceapp): free-disk inspection stats the nearest existing ancestor,
  so a clean Linux install without an existing ~/.config no longer crashes with
  ENOENT;
- fix(run-spaceapp): after a failed image pull on Windows, print an actionable
  hint about Docker Desktop's credential helper requiring an interactive
  Windows session (SSH/CI installs).


## [0.1.26] - 2026-08-14

- ship latest Space app source from /etc/docs/space-src @ f918c46430 (498 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.25] - 2026-08-14

- ship latest Space app source from /etc/docs/space-src @ f918c46430 (498 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.24] - 2026-08-13

- ship latest Space app source from /srv/space @ b24ecc406b (494 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.23] - 2026-08-12

- ship latest Space app source from /srv/space @ bfe12cdca6 (493 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.22] - 2026-08-12

- ship latest Space app source from /srv/space @ 507bb2c132 (492 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.21] - 2026-08-12

- ship latest Space app source from /srv/space @ 75078f4b52 (491 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.20] - 2026-08-12

- ship latest Space app source from /srv/space @ 387a17abc7 (491 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.19] - 2026-08-12

- ship latest Space app source from /srv/space @ 32e1b9f467 (489 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.18] - 2026-08-12

- ship latest Space app source from /srv/space @ b36e8720ad (471 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.17] - 2026-08-07

- ship latest Space app source from /srv/space @ 978010385d (417 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.17] - 2026-08-07

- ship latest Space app source from /srv/space @ b829545c93 (417 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.17] - 2026-08-07

- ship latest Space app source from /srv/space @ 4614e694ac (417 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.17] - 2026-08-07

- ship latest Space app source from /srv/space @ 1a2a36e92c (417 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.17] - 2026-08-07

- ship latest Space app source from /srv/space @ 2589ebea81 (417 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.17] - 2026-08-07

- ship latest Space app source from /srv/space @ 34195c0f41 (417 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.17] - 2026-08-07

- ship latest Space app source from /srv/space @ a968287a42 (417 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.16] - 2026-08-06

- ship latest Space app source from /srv/space @ 729236f8e8 (407 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.15] - 2026-08-06

- ship latest Space app source from /srv/space @ 729236f8e8 (407 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.15] - 2026-08-05

- ship latest Space app source from /srv/space @ 886ab91e09 (403 files, sanitized);
- cross-platform installer for Windows, macOS, and Linux (npm run-spaceapp + GHCR images).


## [0.1.15-hostroot.2] - 2026-07-28

- publish matching `core` and `cli` images for `linux/amd64` so the personal
  candidate can run host-root CLI sessions on x64 Linux;
- reuse the existing signed browser manifest without rebuilding the browser;
- reject the personal candidate on arm64 before Docker image pulls.

## [0.1.15-hostroot.1] - 2026-07-27

- accept the `7.4 GiB` usable memory reported by an 8 GB-class CachyOS laptop
  for the default light profile;
- wait up to ten minutes for first-start readiness, print service status every
  30 seconds, and show recent startup logs every two minutes;
- keep the host-root CLI daemon at UID 0 while sharing its `0660`,
  `root:spaceapp` Unix socket with the non-root core service;
- automatically print final service status and logs before a failed install
  rolls containers back while retaining persistent volumes;
- keep readiness polling active when an intermediate Docker status or log
  diagnostic cannot be collected;
- keep the first-owner setup usable at normal browser zoom on short laptop
  viewports by making the setup shell vertically scrollable;
- accept owner passwords from 6 through 500 characters consistently in setup
  and password reset flows;
- preserve the real error from Linux Docker-group re-entry instead of adding
  the inaccurate claim that installation stopped before image download.

## [0.1.14] - 2026-07-27

- remove an already-running managed browser container when an existing
  `standard` installation moves to the default `light` profile, while
  preserving browser storage and every other persistent Docker volume;
- keep the cleanup idempotent so `light` refreshes also repair state left by
  the superseded, unpromoted `0.1.13` npm candidate without running Compose
  `down`;
- supersede `0.1.13`, which remained off npm `latest` after Windows clean-room
  acceptance exposed Docker Compose retaining a disabled-profile service.

## [0.1.13] - 2026-07-26

- qualify every universal launcher invocation as
  `npx --yes run-spaceapp@latest` so npm resolves the current published
  launcher instead of reusing a matching stale local or cached package;
- make the same command a visible clean-install, stale-update, and idempotent
  refresh path with launcher version, SpaceApp version, profile transition,
  and persistent-state preservation output;
- use the reliable universal prefix in public follow-up examples and launcher
  recovery guidance while keeping global installation optional.

## [0.1.12] - 2026-07-26

- bypass the Microsoft Edge first-run experience when the Windows installer
  opens the local owner-setup page after a clean installation.

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

[Unreleased]: https://github.com/oll4com/spaceapp/compare/v0.1.14...HEAD
[0.1.14]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.14
[0.1.13]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.13
[0.1.12]: https://github.com/oll4com/spaceapp/releases/tag/v0.1.12
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
