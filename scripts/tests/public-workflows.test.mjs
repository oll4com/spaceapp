import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "../..");

async function workflow(name) {
  return readFile(join(root, ".github", "workflows", name), "utf8");
}

test("the native diagnostic push cannot replace full feature, PR or manual source jobs", async () => {
  const source = await workflow("dev-stack.yml");
  const branch = "refs/heads/diagnostics/issue-65-native-pty-nexo";
  assert.match(source, /branches: \["feat\/issue-65-dev-stack-nexo", "diagnostics\/issue-65-native-pty-nexo"\]/);
  assert.match(source, /\n  pull_request:\n    paths:/);
  assert.match(source, /\n  workflow_dispatch:/);
  const full = `github.event_name != 'push' || github.ref != '${branch}'`;
  const diagnostic = `github.event_name == 'push' && github.ref == '${branch}'`;
  for (const job of ["linux-source-stack", "public-source-tests", "macos-source-stack"]) {
    const condition = source.match(new RegExp(`\\n  ${job}:\\n    if: ([^\\n]+)`))?.[1];
    assert.equal(condition, full);
  }
  assert.equal(source.match(/\n  native-pty-diagnostic:\n[^\n]*\n    if: ([^\n]+)/)?.[1], diagnostic);
  // The pinned simple expressions have identical JS/GitHub boolean semantics.
  for (const [event_name, ref, expectedFull, expectedDiagnostic] of [
    ["push", branch, false, true],
    ["push", "refs/heads/feat/issue-65-dev-stack-nexo", true, false],
    ["pull_request", "refs/pull/1/merge", true, false],
    ["workflow_dispatch", branch, true, false]
  ]) {
    const github = { event_name, ref };
    assert.equal(new Function("github", `return ${full};`)(github), expectedFull);
    assert.equal(new Function("github", `return ${diagnostic};`)(github), expectedDiagnostic);
  }
});

test("the macOS native control keeps original tests and cannot start or repair the full stack", async () => {
  const source = await workflow("dev-stack.yml");
  const job = source.split("\n  native-pty-diagnostic:\n")[1];
  assert.ok(job);
  assert.match(job, /runs-on: macos-15-intel/);
  assert.match(job, /timeout-minutes: 10/);
  assert.match(job, /persist-credentials: false/);
  assert.match(job, /node-version-file: \.nvmrc/);
  assert.match(job, /ELECTRON_SKIP_BINARY_DOWNLOAD: "1"/);
  assert.match(job, /run: npm ci/);
  const build = job.indexOf("run: npm run build -w @space/cli-host");
  const tests = job.indexOf("['--test', 'scripts/tests/contributor-smoke.test.mjs']");
  assert.ok(build >= 0 && tests >= 0 && build < tests);
  assert.doesNotMatch(job, /continue-on-error|--ignore-scripts|colima|brew|upload-artifact|dev-stack-ci|chmodSync\(helper/);
  for (const ref of job.matchAll(/uses:\s+([^\s]+)/g)) assert.match(ref[1], /@[0-9a-f]{40}$/);
  const metadata = job.match(/node --input-type=commonjs <<'NODE'\n([\s\S]*?)\n          NODE/)[1]
    .split("\n").map(line => line.slice(10)).join("\n");
  assert.doesNotThrow(() => new Function(metadata));
  assert.match(metadata, /path\.relative\(root, binding\)/);
  assert.match(metadata, /fs\.accessSync\(helper, fs\.constants\.X_OK\)/);
  const control = job.match(/node --input-type=commonjs <<'CONTROL'\n([\s\S]*?)\n          CONTROL/)[1]
    .split("\n").map(line => line.slice(10)).join("\n");
  assert.doesNotThrow(() => new Function(control));
  assert.match(control, /fs\.constants\.O_NOFOLLOW/);
  assert.match(control, /stat\.nlink === 1 && stat\.uid === process\.getuid\(\)/);
  assert.match(control, /fs\.fchmodSync\(fd, originalMode \| 0o100\)/);
  assert.match(control, /finally \{\n\s+fs\.fchmodSync\(fd, originalMode\)/);
  assert.match(control, /assert\.equal\(digest\(\), originalHash\)/);
});

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
  assert.match(platform, /- os: windows-latest\s+node: "24"/);
  assert.equal([...platform.matchAll(/- os: windows-latest/g)].length, 2);
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
