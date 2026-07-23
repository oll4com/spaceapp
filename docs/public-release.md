# Public release runbook

SpaceApp must never be published from the private repository history or from a
live runtime directory. The release source is a sanitized, audited,
clean-history export of one verified commit.

No npm package, GHCR image, GitHub repository, tag, or release is published
merely by running the preparation checks below. Publication requires separate
maintainer authorization and the protected `public-release` GitHub
environment.

## 1. Prepare the candidate

Start from a clean feature or release commit:

```bash
npm ci
npm run check
npm run test:public
npm run build
npm audit --audit-level=high
npm run public:export:verify
```

Build all container targets locally and validate the generated launcher
Compose configuration. Run the first-owner, synthetic workspace,
backup/restore, update, and rollback flows in the clean-room VM.

The candidate is blocked when:

- any high or critical dependency/container vulnerability remains;
- the public-export audit finds a private hostname, internal path, known
  private network value, personal-memory path, credential-shaped value, secret
  file, runtime data, symlink, or generated dependency/build directory;
- the npm tarball or image inventory differs from the reviewed pins;
- Windows, macOS, Linux, amd64, or arm64 support is missing without an explicit
  release-note exception;
- browser setup proof has console/network failures;
- backup/restore or rollback has not been exercised.

## 2. Create the clean-history source

Choose a new, empty directory outside the private worktree:

```bash
npm run public:export -- --output /absolute/path/to/spaceapp-public-export
```

The exporter copies only the public allowlist, applies deterministic generic
replacements, rejects unsafe files/content, and writes
`PUBLIC_EXPORT_MANIFEST.json` with the private source commit, file hashes,
sizes, and transformation count.

Inspect the export, then create a new Git object graph inside that directory:

```bash
cd /absolute/path/to/spaceapp-public-export
git init --initial-branch=main
git add .
git commit -m "release: SpaceApp 0.1.0-alpha.1"
```

Never add the private repository as a remote, push its branches/tags, copy its
`.git` directory, or use a history-rewrite tool as a substitute for the fresh
repository.

Run the complete public CI and security workflows against this clean-history
repository before any registry publication.

## 3. Verify artifacts without publishing

The release workflow defaults to verification only. It must:

- check that the requested version equals `run-spaceapp/package.json`;
- run launcher, public distribution, API setup, and web onboarding tests;
- run the OS launcher matrix;
- build core, CLI, and browser targets for the declared architectures;
- scan source and images for high/critical vulnerabilities;
- generate SBOMs and preserve build provenance;
- create the npm tarball and inspect its file list;
- upload candidate artifacts only to the private workflow run.

Tag pushes do not publish packages. The workflow's `publish` input defaults to
`false`.

## 4. Authorized publication

Only a maintainer who has reviewed the clean-history commit and clean-room
evidence may:

1. approve the protected `public-release` environment;
2. run the release workflow manually with the exact alpha version and
   `publish=true`;
3. publish `run-spaceapp` with npm dist-tag `alpha` and provenance;
4. publish matching `spaceapp-core`, `spaceapp-cli`, and
   `spaceapp-browser` multi-architecture GHCR manifests;
5. create the matching Git tag and GitHub prerelease from the clean-history
   repository;
6. verify the public npm metadata, image digests, SBOMs, provenance, and a
   completely fresh install.

Raw provider credentials, production secrets, or private clean-room state must
never be added to GitHub Actions secrets. Registry credentials must use the
platform's protected secret or trusted-publishing mechanism.

## 5. Rollback

If post-publication verification fails:

- move installation guidance back to the last verified version;
- restore the npm `alpha` dist-tag to that version;
- mark the affected GitHub release as withdrawn and document the reason;
- do not delete immutable image tags or rewrite public Git history;
- publish a fixed alpha with a new version;
- tell affected owners whether `spaceapp rollback` is sufficient or whether a
  pre-update backup restore is required.

Treat any accidentally published secret as compromised: revoke and rotate it
before attempting history or artifact cleanup.
