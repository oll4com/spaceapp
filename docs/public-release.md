# Public release runbook

SpaceApp releases are built only from the sanitized public export of the
reviewed `main` commit. Never publish from private history, a developer
worktree, or a live runtime directory.

## Protected release identity

`.github/workflows/release.yml` is manual-only and rejects dispatches outside
`main`. The requested version must exactly equal
`packages/run-spaceapp/package.json`.

The GitHub Environment is named `npm` and must have:

- required reviewer GitHub account `oll4com`;
- deployment branch policy limited to `main`;
- wait timer `0`.

The npm Trusted Publisher must identify organization `oll4com`, repository
`spaceapp`, workflow `release.yml`, and Environment `npm`. Publishing uses npm
CLI `11.18.0`, GitHub OIDC, and `id-token: write`; an `NPM_TOKEN` or other npm
registry credential is forbidden.

Candidate jobs have only `contents: read`. Jobs behind the protected
Environment have only `contents: read`, `packages: write`, and
`id-token: write`.

## Candidate gates

Before requesting Environment approval, the workflow:

1. creates a sanitized export and archives it before dependencies or build
   output are added;
2. runs `npm ci`, `npm audit --audit-level=high`, `npm run test:public`,
   `npm run check`, `npm run build`, and the npm package dry run;
3. builds `core`, `cli`, and `browser` for both `linux/amd64` and
   `linux/arm64`;
4. enforces image-size budgets;
5. blocks every fixable Medium, High, or Critical Trivy finding;
6. stores complete JSON reports, including upstream-unfixed findings, as
   workflow artifacts and job summaries.

The scheduled Security workflow re-runs the same fixable gate weekly.
Upstream-unfixed Debian findings, including `acl`, `attr`, `util-linux`,
`diffutils`, and `perl-base`, remain visible and are not ignored.

## Publication order

After approval, `release-artifact-preflight.mjs` proves that neither
`run-spaceapp@<version>` nor any exact GHCR tag already exists. A registry
timeout, authentication failure, or ambiguous response blocks the release.
Existing artifacts are never overwritten.

The workflow then:

1. publishes exact-version `core`, `cli`, and `browser` GHCR manifests from
   the archived sanitized source;
2. includes `linux/amd64`, `linux/arm64`, BuildKit SBOM, and maximum
   provenance attestations for every image;
3. verifies both architectures and both attestation classes;
4. verifies the checksum of the npm tarball produced by the candidate job;
5. publishes that tarball as `run-spaceapp@<version>` with the explicitly
   selected `next` or `personal` tag and `--provenance`.

For `0.1.14`, `latest` must remain `0.1.12` until clean-install acceptance is
complete.

## Personal host-root prerelease

For `0.1.15-hostroot.0`, dispatch `release.yml` from `main` with:

- `version`: `0.1.15-hostroot.0`;
- `npm_tag`: `personal`.

The full candidate, audit, Trivy, multi-architecture, SBOM, provenance, and
artifact-existence gates remain mandatory. Do not change `latest` or `next`.
After publication, confirm:

- `run-spaceapp@0.1.15-hostroot.0` exists and has the reviewed `gitHead`;
- `dist-tags.personal` is `0.1.15-hostroot.0`;
- `latest` and `next` are unchanged;
- all three exact GHCR tags expose `linux/amd64`, `linux/arm64`, SBOM, and
  provenance.

Run the isolated CachyOS acceptance with the exact user command:

```bash
npx --yes run-spaceapp@personal install --access host-root
```

Verify `/host` read/write behavior only with a synthetic temporary host file,
then run the same command again for idempotency. Finally run
`npx --yes run-spaceapp@personal install --access isolated` and prove the host
root mount is absent while application data and volumes remain.

If acceptance fails, remove or restore only the `personal` dist-tag and
deprecate the exact npm version. Exact npm and GHCR version artifacts remain
immutable. Do not modify `latest`, `next`, or any existing live SpaceApp or
website installation.

## Staged acceptance and promotion

Verify npm metadata before installation:

- `version` and `next` are `0.1.14`;
- `latest` is still `0.1.12`;
- `gitHead` equals the released `main` commit;
- provenance is present and references `.github/workflows/release.yml`.

Create an isolated temporary installation root and run the pre-promotion
candidate explicitly:

```bash
npx --yes run-spaceapp@next install
```

Start the light profile, wait for `/readyz`, exercise every command exposed by
`npx --yes run-spaceapp@next help`, the first-owner token flow, CLI host, and
persistent-state update behavior. Run a separate explicit standard-profile
cycle for the browser host, then remove the complete temporary installation.
Never use `/srv/space` for release acceptance.

Before promotion:

- the authenticated npm maintainer appears in `npm owner ls run-spaceapp`;
- both maintainers have active 2FA;
- every clean-install and image verification is green.

Promote with a 2FA-protected maintainer session:

```bash
npm dist-tag add run-spaceapp@0.1.14 latest
```

Immediately verify the promoted public path with the exact end-user command:

```bash
npx --yes run-spaceapp@latest install
```

Then set package Publishing Access to **Require 2FA and disallow tokens** and
revoke every write-capable npm token, including the former host-scoped
publishing token. Confirm a final Snyk re-test has no fixable findings; do not
add ignores for upstream-unfixed findings.

## Rollback

Published npm versions and GHCR exact tags are immutable.

If `0.1.14` fails acceptance or after promotion:

```bash
npm dist-tag add run-spaceapp@0.1.12 latest
npm dist-tag add run-spaceapp@0.1.12 next
npm deprecate run-spaceapp@0.1.14 "Withdrawn after release verification; use 0.1.12 until a corrected release is available."
npm view run-spaceapp dist-tags --json
```

Verify that both `latest` and `next` report `0.1.12`. Exact version artifacts
remain immutable and must not be deleted or overwritten.

The failed `0.1.4` staging run and superseded, unpromoted `0.1.13` candidate
already produced immutable artifacts, so preserve those and the unpromoted
`0.1.7` and `0.1.8` artifacts as evidence. Do not delete or overwrite exact
version tags.

## Official references

- npm Trusted Publishers:
  https://docs.npmjs.com/trusted-publishers/
- GitHub deployment environments:
  https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments
- GitHub Actions full-SHA hardening:
  https://docs.github.com/en/actions/how-tos/security-for-github-actions/security-guides/security-hardening-for-github-actions
- Docker SBOM and provenance attestations:
  https://docs.docker.com/build/ci/github-actions/attestations/
