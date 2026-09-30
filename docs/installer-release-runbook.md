# Installer release: one candidate, measured results

This runbook is for an agent maintaining the public launcher. Do not improvise a
publish sequence or replace a failed test with `--plan`, `--help`, SSH status or
an already-running old app. Never reset a checkout to discard uncommitted work.
All commits go directly to main. The live host and public installer are separate.

## Prepare

1. Confirm source and public checkout are on main and preserve unrelated changes.
2. Run the configured setup-sync engine without publication. It exports a pinned
   source commit, sanitizes private identifiers, preserves launcher/container
   overlays and updates the launcher/runtime version together. Native client
   binaries and download archives do not belong in the server Docker build.
3. Stop on an unreviewed binary or private identifier. Review the actual content
   and update the exporter policy explicitly; never bypass the sanitizer.
4. Run launcher tests, export tests, distribution contracts and the full build.
   Include required build scripts/demo sources. Preserve the source license;
   a sync is not permission to relicense new code.
5. Review the complete candidate and commit it on main. Generate a new version
   whenever creating a different build for review. Do not retag an old image.

## Test the exact candidate

Use the configured dedicated lab runners. Never run reset tests on a real user's
machine. Record source digest, package SHA256, image digests, actual exit codes,
start/end times and retained evidence. Keep secrets out of reports.

- Fresh install: no previous SpaceApp config; real installer execution; readiness,
  correct images; owner setup and automatic browser opening observed.
- Upgrade: create an owned database marker, workspace record and persistent file;
  compare before/after including secret hashes; verify the target image versions.
- Repair and doctor: diagnose failure, repair without deleting volumes, wait for
  readiness. Confirm help works before config/Docker exists.
- Stopped Docker: stop the dedicated lab engine, prove `docker info` fails, run
  install, then prove engine/app readiness and preserved data. Windows requires a
  real graphical sign-in: SSH process lifetime is not desktop acceptance.
- First agent: native OpenCode catalog with explicit zero prices, submitted task,
  native task/session id and completed response. A pane opening is insufficient.
- Linux, Windows and macOS must each have real evidence. Missing runners are
  UNTESTED, never PASS. ARM64 image build validation is separate from host UX.

Create `release/acceptance.json` (schema 1) with `candidateDigest` from
`candidateDigest()` in `scripts/release-evidence.mjs`, launcher/runtime versions,
UTC `createdAt`, and `checks` per platform/scenario. Each check carries `pass`,
`executed`, `exitCode`, `ready`, and a retained `artifactSha256`. Upgrade/repair/
stopped-Docker also require `dataPreserved`; stopped-Docker requires
`dockerInitiallyStopped`; first-agent requires `nativeTaskId`, `responseObserved`,
`uiOpened` and `freeModel`; Windows also requires `interactiveDesktop`.

The digest excludes only acceptance.json, so committing evidence does not change
the candidate identity. A code, dependency, workflow, Dockerfile or version change
invalidates previous evidence. Evidence older than seven days is rejected.

## Publish

Run `node scripts/publish-prepared.mjs` for the final gate. After it succeeds,
`node scripts/publish-prepared.mjs --publish` pushes main and dispatches the
existing release workflow. It never changes source or versions after testing.
The workflow repeats the evidence gate before source/container publication.
Keep the existing environment review, signing/provenance and vulnerability gates.
Only a fully accepted published `next` package may be promoted to `latest` using
the maintainer's npm session. Do not bypass npm 2FA or protected environment review.

Publish the final redacted report to the user's Agent Files dock and retain exact
artifact IDs. Mark the existing task PLAN complete only after all required work
is complete. If a runner or external gate is missing, record what is proven and
what remains blocked; never claim all-platform completion.
