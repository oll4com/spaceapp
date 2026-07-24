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

test("launcher and container matrices cover the declared operating systems and architectures", async () => {
  const platform = await workflow("platform-matrix.yml");
  const containers = await workflow("containers.yml");

  for (const os of ["ubuntu-latest", "macos-latest", "windows-latest"]) {
    assert.match(platform, new RegExp(os));
  }
  for (const target of ["core", "browser", "cli"]) {
    assert.match(containers, new RegExp(`- ${target}`));
  }
  assert.match(containers, /- amd64/);
  assert.match(containers, /- arm64/);
  assert.match(containers, /push: false/);
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
  assert.doesNotMatch(trigger, /pull_request:|schedule:|\n  push:/);
  assert.match(release, /permissions:\n  contents: read/);
  assert.match(release, /github\.ref == 'refs\/heads\/main'/);
  assert.match(release, /node scripts\/public-export\.mjs/g);
  assert.match(release, /context: \$\{\{ runner\.temp \}\}\/spaceapp-public-export/);
  assert.match(release, /working-directory: \$\{\{ runner\.temp \}\}\/spaceapp-public-export/g);
  assert.match(release, /actions\/upload-artifact/);
  assert.match(release, /push: false/);
  assert.match(release, /node scripts\/release-artifact-preflight\.mjs/);
  assert.match(release, /environment: npm/g);
  assert.match(release, /packages: write/g);
  assert.match(release, /id-token: write/g);
  assert.doesNotMatch(release, /contents: write/);
  assert.match(release, /docker\/login-action/);
  assert.match(release, /platforms: linux\/amd64,linux\/arm64/);
  assert.match(release, /ghcr\.io\/oll4com\/spaceapp-\$\{\{ matrix\.target \}\}:\$\{\{ inputs\.version \}\}/);
  assert.match(release, /push: true/);
  assert.match(release, /sbom: true/);
  assert.match(release, /provenance: mode=max/);
  assert.match(release, /npm install --global --ignore-scripts --no-audit --no-fund npm@11\.18\.0/);
  assert.match(release, /npm pkg set "gitHead=\$\{\{ github\.sha \}\}" -w run-spaceapp/);
  assert.match(release, /npm publish "\$RUNNER_TEMP\/release-artifacts\/run-spaceapp-\$\{\{ inputs\.version \}\}\.tgz" --tag next --provenance/);
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
