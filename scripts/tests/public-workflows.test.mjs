import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

async function workflow(name) {
  return readFile(join(root, ".github", "workflows", name), "utf8");
}

test("CI creates and validates only the sanitized public candidate", async () => {
  const ci = await workflow("ci.yml");

  assert.match(ci, /node scripts\/public-export\.mjs/);
  assert.match(ci, /working-directory: \$\{\{ runner\.temp \}\}\/spaceapp-public-export/g);
  assert.match(ci, /npm run test:public/);
  assert.match(ci, /npm run check/);
  assert.match(ci, /npm run build/);
  assert.match(ci, /npm run pack:dry-run -w run-spaceapp/);
  assert.doesNotMatch(ci, /npm test -w @space\/(?:api|web)/);
  assert.doesNotMatch(ci, /name: Full repository suite/);
  assert.doesNotMatch(ci, /\n\s*run: npm test\s*$/m);
  assert.doesNotMatch(ci, /cli-runtimes\.test\.ts/);
  assert.doesNotMatch(ci, /public-deployment-config\.test\.ts/);
});

test("CI and the release run the *-postgres tests on the compose file's pinned PostgreSQL image", async () => {
  const compose = await readFile(join(root, "packages", "run-spaceapp", "templates", "compose.yml"), "utf8");
  assert.match(compose, /image: pgvector\/pgvector:[^@\s]+@sha256:[0-9a-f]{64}\n/);
  for (const name of ["ci.yml", "release.yml"]) {
    const text = await workflow(name);
    const pull = text.indexOf("docker pull \"$pinned\" && docker tag \"$pinned\" \"${pinned%@*}\"");
    assert.ok(pull > 0, name);
    assert.ok(pull < text.indexOf("npm run test:public"), `${name} pulls before the tests`);
  }
});

test("launcher and container matrices cover the declared operating systems and architectures", async () => {
  const platform = await workflow("platform-matrix.yml");
  const containers = await workflow("containers.yml");

  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(platform, new RegExp(os));
  }
  assert.match(
    platform,
    /name: Launcher \/ \$\{\{ matrix\.os \}\} \/ Node \$\{\{ matrix\.node \}\}/
  );
  assert.match(
    platform,
    /if: runner\.arch == 'ARM64'[\s\S]*run: npm ci --force/
  );
  assert.match(
    platform,
    /if: runner\.arch != 'ARM64'[\s\S]*run: npm ci/
  );
  // Every host runs Node 20, 22 and 26; Windows also keeps 24 (03c9b2f, plan NtXOwLkXVN1x step 5).
  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    for (const node of ["20.20.2", "22.23.4", "26.13.0"]) {
      assert.match(platform, new RegExp(`- os: ${os}\\s+node: "${node.replaceAll(".", "\\.")}"`));
    }
  }
  assert.match(platform, /- os: windows-latest\s+node: "24"/);
  assert.equal([...platform.matchAll(/- os: windows-latest/g)].length, 4);
  for (const target of ["core", "browser", "cli"]) {
    assert.match(containers, new RegExp(`- ${target}`));
  }
  assert.match(containers, /- amd64/);
  assert.match(containers, /- arm64/);
  assert.match(containers, /push: false/);
});

test("launcher-only source and workflow changes cannot trigger the container matrix", async () => {
  const containers = await workflow("containers.yml");
  const trigger = containers.match(/\non:\n([\s\S]*?)\npermissions:/)?.[1] || "";

  assert.match(trigger, /pull_request:[\s\S]*paths:/);
  assert.match(trigger, /push:[\s\S]*branches:[\s\S]*- main[\s\S]*paths:/);
  assert.match(trigger, /- "packages\/\*\*"/);
  assert.match(trigger, /- "!packages\/run-spaceapp\/\*\*"/);
  assert.doesNotMatch(trigger, /\.github\/workflows\/containers\.yml/);
});

test("container matrices load each image and enforce the public size budgets", async () => {
  for (const name of ["containers.yml", "release.yml"]) {
    const content = await workflow(name);

    assert.match(content, /load: true/);
    assert.match(content, /node scripts\/container-image-size-budget\.mjs/);
    assert.match(content, /--target "\$\{\{ matrix\.target \}\}"/);
    assert.match(content, /--image "spaceapp-ci:\$\{\{ matrix\.target \}\}-\$\{\{ matrix\.arch \}\}"/);
  }
});

test("security workflow scans secrets, dependencies, source, images, and emits an SBOM", async () => {
  const security = await workflow("security.yml");

  assert.match(security, /container-changes:[\s\S]*outputs:[\s\S]*required:/);
  assert.match(
    security,
    /git diff --quiet[\s\S]*':\(exclude\)packages\/run-spaceapp\/\*\*'/
  );
  assert.match(
    security,
    /image:[\s\S]*needs: container-changes[\s\S]*if: needs\.container-changes\.outputs\.required == 'true'/
  );
  assert.match(security, /npm audit --audit-level=high/);
  assert.match(security, /gitleaks\/gitleaks-action/);
  assert.match(security, /aquasecurity\/trivy-action/);
  assert.deepEqual(
    [...security.matchAll(/uses:\s+aquasecurity\/trivy-action@([^\s]+)/g)]
      .map((match) => match[1]),
    [
      "ed142fd0673e97e23eac54620cfb913e5ce36c25",
      "ed142fd0673e97e23eac54620cfb913e5ce36c25",
      "ed142fd0673e97e23eac54620cfb913e5ce36c25",
      "ed142fd0673e97e23eac54620cfb913e5ce36c25"
    ]
  );
  assert.equal(
    [...security.matchAll(/limit-severities-for-sarif:\s+true/g)].length,
    2
  );
  assert.equal(
    [...security.matchAll(/severity: MEDIUM,HIGH,CRITICAL/g)].length,
    2
  );
  assert.equal([...security.matchAll(/ignore-unfixed: true/g)].length, 2);
  assert.equal([...security.matchAll(/exit-code: "1"/g)].length, 2);
  assert.equal([...security.matchAll(/format: json/g)].length, 2);
  assert.equal([...security.matchAll(/ignore-unfixed: false/g)].length, 2);
  assert.equal([...security.matchAll(/exit-code: "0"/g)].length, 2);
  assert.match(security, /UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL/);
  assert.match(security, /trivy-full-[^\s]*\.json/);
  assert.match(security, /GITHUB_STEP_SUMMARY/);
  assert.match(security, /actions\/upload-artifact/);
  assert.match(security, /anchore\/sbom-action/);
  assert.match(security, /github\/codeql-action\/analyze/);
  assert.match(security, /actions\/dependency-review-action/);
});

test("release is manual-only on main and publishes only approved sanitized artifacts", async () => {
  const release = await workflow("release.yml");
  const trigger = release.match(/\non:\n([\s\S]*?)\npermissions:/)?.[1] || "";

  assert.match(release, /^name: Public OIDC release$/m);
  assert.doesNotMatch(release, /alpha/i);
  assert.doesNotMatch(release, /--allow-review-required/);
  assert.match(trigger, /workflow_dispatch:/);
  assert.match(trigger, /npm_tag:[\s\S]*type: choice[\s\S]*- next[\s\S]*- personal/);
  assert.match(
    trigger,
    /release_mode:[\s\S]*type: choice[\s\S]*- full[\s\S]*- launcher-only[\s\S]*- amd64-core-cli/
  );
  assert.match(trigger, /runtime_version:[\s\S]*required: true[\s\S]*type: string/);
  assert.match(trigger, /browser_source_version:[\s\S]*required: false[\s\S]*type: string/);
  assert.doesNotMatch(trigger, /pull_request:|schedule:|\n  push:/);
  assert.match(release, /permissions:\n  contents: read/);
  assert.match(release, /github\.ref == 'refs\/heads\/main'/);
  assert.match(
    release,
    /RELEASE_VERSION: \$\{\{ inputs\.version \}\}[\s\S]*RELEASE_DIST_TAG: \$\{\{ inputs\.npm_tag \}\}[\s\S]*--version "\$RELEASE_VERSION"[\s\S]*--npm-tag "\$RELEASE_DIST_TAG"/
  );
  assert.match(release, /node scripts\/public-export\.mjs/g);
  assert.match(release, /context: \$\{\{ runner\.temp \}\}\/spaceapp-public-export/);
  assert.match(release, /working-directory: \$\{\{ runner\.temp \}\}\/spaceapp-public-export/g);
  assert.match(release, /actions\/upload-artifact/);
  assert.match(release, /push: false/);
  assert.match(release, /node scripts\/release-artifact-preflight\.mjs/);
  assert.match(release, /--release-mode "\$\{\{ inputs\.release_mode \}\}"/);
  assert.match(
    release,
    /node scripts\/verify-published-containers\.mjs[\s\S]*--version "\$\{\{ inputs\.runtime_version \}\}"/
  );
  // A full release's images are verified as built by this run's commit (image-attestations.mjs, review IR117-C-F7).
  assert.match(
    release,
    /verify-containers:[\s\S]*node scripts\/verify-published-containers\.mjs\n\s+--version "\$\{\{ inputs\.version \}\}"\n\s+--workflow-sha "\$\{\{ github\.sha \}\}"/
  );
  assert.match(release, /container-candidate:[\s\S]*if: inputs\.release_mode == 'full'/);
  assert.match(
    release,
    /publish-containers:[\s\S]*if: >-[\s\S]*always\(\) &&[\s\S]*needs\.publish-preflight\.result == 'success' &&[\s\S]*inputs\.release_mode == 'full'/
  );
  assert.match(release, /existing-runtime:[\s\S]*if: inputs\.release_mode == 'launcher-only'/);
  assert.match(
    release,
    /amd64-container-candidate:[\s\S]*if: inputs\.release_mode == 'amd64-core-cli'[\s\S]*target:[\s\S]*- core[\s\S]*- cli[\s\S]*platforms: linux\/amd64/
  );
  assert.match(
    release,
    /publish-amd64-containers:[\s\S]*if: >-[\s\S]*always\(\) &&[\s\S]*needs\.publish-preflight\.result == 'success' &&[\s\S]*inputs\.release_mode == 'amd64-core-cli'[\s\S]*target:[\s\S]*- core[\s\S]*- cli[\s\S]*platforms: linux\/amd64/
  );
  assert.match(
    release,
    /reuse-browser-manifest:[\s\S]*if: >-[\s\S]*always\(\) &&[\s\S]*needs\.publish-preflight\.result == 'success' &&[\s\S]*inputs\.release_mode == 'amd64-core-cli'[\s\S]*docker buildx imagetools create[\s\S]*spaceapp-browser:\$\{\{ inputs\.version \}\}[\s\S]*spaceapp-browser:\$\{\{ inputs\.browser_source_version \}\}/
  );
  assert.match(
    release,
    /verify-containers:[\s\S]*if: >-[\s\S]*always\(\) &&[\s\S]*needs\.publish-containers\.result == 'success' &&[\s\S]*inputs\.release_mode == 'full'/
  );
  assert.match(
    release,
    /verify-amd64-containers:[\s\S]*if: >-[\s\S]*always\(\) &&[\s\S]*needs\.publish-amd64-containers\.result == 'success' &&[\s\S]*needs\.reuse-browser-manifest\.result == 'success' &&[\s\S]*inputs\.release_mode == 'amd64-core-cli'/
  );
  assert.match(
    release,
    /publish-npm:[\s\S]*if: >-[\s\S]*always\(\)[\s\S]*needs\.existing-runtime\.result == 'success'/
  );
  assert.match(release, /environment: npm/g);
  assert.match(release, /packages: write/g);
  assert.match(release, /id-token: write/g);
  for (const [job, nextJob] of [
    ["publish-preflight", "publish-containers"],
    ["verify-containers", "publish-npm"]
  ]) {
    const block = release.match(
      new RegExp(`\\n  ${job}:\\n([\\s\\S]*?)\\n  ${nextJob}:`)
    )?.[1] || "";
    assert.match(block, /packages: read/);
    assert.doesNotMatch(block, /packages: write|id-token: write/);
  }
  assert.doesNotMatch(release, /contents: write/);
  assert.match(release, /docker\/login-action/);
  assert.match(release, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(release, /ghcr\.io\/oll4com\/spaceapp-\$\{\{ matrix\.target \}\}:\$\{\{ inputs\.version \}\}/);
  assert.match(release, /push: true/);
  assert.match(release, /sbom: true/);
  assert.match(release, /provenance: mode=max/);
  assert.match(release, /npm install --global --ignore-scripts --no-audit --no-fund npm@11\.18\.0/);
  assert.match(release, /npm pkg set "gitHead=\$\{\{ github\.sha \}\}" -w run-spaceapp/);
  assert.match(release, /node scripts\/publish-npm-candidate\.mjs/);
  assert.match(release, /RELEASE_VERSION: \$\{\{ inputs\.version \}\}/);
  assert.match(release, /RELEASE_DIST_TAG: \$\{\{ inputs\.npm_tag \}\}/);
  assert.match(release, /RELEASE_GIT_HEAD: \$\{\{ github\.sha \}\}/);
  assert.doesNotMatch(release, /NPM_TOKEN|NODE_AUTH_TOKEN|npm publish \.\/packages\/run-spaceapp/);
  assert.match(release, /actions\/download-artifact/);
  assert.match(release, /spaceapp-public-export-\$\{\{ inputs\.version \}\}\.tar\.gz/);
  // External review 2026-10-16 #8: after the images are verified, their digests are pinned into the tested package
  // and only the pinned tarball is published.
  const publishNpm = release.match(/\n  publish-npm:\n([\s\S]*)$/)?.[1] || "";
  assert.match(
    publishNpm,
    /Verify npm candidate checksum[\s\S]*docker\/login-action[\s\S]*node scripts\/embed-image-lock\.mjs[\s\S]*--runtime-version "\$\{\{ inputs\.runtime_version \}\}"[\s\S]*node scripts\/publish-npm-candidate\.mjs "\$RUNNER_TEMP\/pinned-npm-candidate\/run-spaceapp-\$\{\{ inputs\.version \}\}\.tgz"/
  );
  assert.doesNotMatch(publishNpm, /publish-npm-candidate\.mjs "\$RUNNER_TEMP\/release-artifacts\//);
});

test("workflow actions use full commit SHA pins with version comments", async () => {
  for (const name of ["ci.yml", "platform-matrix.yml", "containers.yml", "security.yml", "release.yml"]) {
    const content = await workflow(name);
    assert.doesNotMatch(content, /pull_request_target:/);
    for (const reference of content.matchAll(/uses:\s+([^@\s]+)@([0-9a-f]{40})(?:\s+#\s+([^\s]+))?/g)) {
      assert.match(reference[1], /^[\w.-]+\/[\w./-]+$/);
      assert.match(reference[2], /^[0-9a-f]{40}$/);
      assert.match(reference[3] || "", /^v?\d+\.\d+\.\d+$/);
    }
    const usesCount = [...content.matchAll(/uses:\s+/g)].length;
    const pinnedCount = [...content.matchAll(/uses:\s+[^@\s]+@[0-9a-f]{40}\s+#\s+v?\d+\.\d+\.\d+/g)].length;
    assert.equal(pinnedCount, usesCount, `${name} must pin every action by full commit SHA`);
  }
});

// Review 5/5 F5 (plan clipboard:NtzEOzE3Ew00 step 4): BuildKit's provenance sits unsigned in the registry, so anyone
// who can push there could replace it; each published image also gets a Sigstore-signed GitHub attestation bound to
// this workflow, and the release verifies it names this repository, this workflow and this run's commit.
test("published images get a signed build provenance attestation the release verifies against its own commit", async () => {
  const release = await workflow("release.yml");
  const job = (name) => release.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:\\n|$)`))?.[1] || "";
  for (const name of ["publish-containers", "publish-amd64-containers"]) {
    const block = job(name);
    assert.match(block, /permissions:[\s\S]*packages: write[\s\S]*id-token: write[\s\S]*attestations: write/, name);
    assert.match(
      block,
      /uses: docker\/build-push-action@[0-9a-f]{40}[^\n]*\n\s+id: push\n/,
      `${name}: the build step must expose its digest`
    );
    assert.match(
      block,
      /uses: actions\/attest-build-provenance@[0-9a-f]{40} # v\d+\.\d+\.\d+\n\s+with:\n\s+subject-name: ghcr\.io\/oll4com\/spaceapp-\$\{\{ matrix\.target \}\}\n\s+subject-digest: \$\{\{ steps\.push\.outputs\.digest \}\}\n\s+push-to-registry: true\n/,
      `${name}: attest the pushed digest`
    );
  }
  const verify = (block, targets) => {
    assert.match(block, /GH_TOKEN: \$\{\{ github\.token \}\}/);
    assert.match(block, new RegExp(`for target in ${targets}; do`));
    assert.match(
      block,
      /gh attestation verify "oci:\/\/ghcr\.io\/oll4com\/spaceapp-\$target:\$\{\{ inputs\.version \}\}"[\s\\]+--repo oll4com\/spaceapp[\s\\]+--signer-workflow oll4com\/spaceapp\/\.github\/workflows\/release\.yml[\s\\]+--source-digest "\$\{\{ github\.sha \}\}"/
    );
  };
  verify(job("verify-containers"), "core browser cli");
  // The amd64 mode copies an earlier release's browser manifest: only the images this run built carry its commit.
  verify(job("verify-amd64-containers"), "core cli");
  assert.equal([...release.matchAll(/attestations: write/g)].length, 2, "only the two publish jobs sign");
});
