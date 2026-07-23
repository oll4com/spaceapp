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
  assert.match(ci, /cli-runtime-descriptors\.test\.ts/);
  assert.match(ci, /owner-setup\.test\.tsx/);
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

test("security workflow scans secrets, dependencies, source, images, and emits an SBOM", async () => {
  const security = await workflow("security.yml");

  assert.match(security, /npm audit --audit-level=high/);
  assert.match(security, /gitleaks\/gitleaks-action/);
  assert.match(security, /aquasecurity\/trivy-action/);
  assert.deepEqual(
    [...security.matchAll(/uses:\s+aquasecurity\/trivy-action@([^\s]+)/g)]
      .map((match) => match[1]),
    ["v0.33.1", "v0.33.1"]
  );
  assert.match(security, /severity: HIGH,CRITICAL/);
  assert.match(security, /anchore\/sbom-action/);
  assert.match(security, /github\/codeql-action\/analyze/);
  assert.match(security, /actions\/dependency-review-action/);
});

test("release is manual, candidate-only, and builds exclusively from the sanitized export", async () => {
  const release = await workflow("release.yml");
  const trigger = release.match(/\non:\n([\s\S]*?)\npermissions:/)?.[1] || "";

  assert.match(trigger, /workflow_dispatch:/);
  assert.doesNotMatch(trigger, /pull_request:|schedule:|\n  push:/);
  assert.match(release, /permissions:\n  contents: read/);
  assert.match(release, /node scripts\/public-export\.mjs/g);
  assert.match(release, /context: \$\{\{ runner\.temp \}\}\/spaceapp-public-export/);
  assert.match(release, /working-directory: \$\{\{ runner\.temp \}\}\/spaceapp-public-export/g);
  assert.match(release, /actions\/upload-artifact/);
  assert.match(release, /push: false/);
  assert.doesNotMatch(release, /npm publish|docker\/login-action|gh release|push: true/);
  assert.doesNotMatch(release, /packages: write|contents: write|id-token: write/);
  assert.doesNotMatch(release, /\npublish:/);
  assert.doesNotMatch(release, /environment:/);
});

test("workflow actions use versioned references and avoid privileged pull-request triggers", async () => {
  for (const name of ["ci.yml", "platform-matrix.yml", "containers.yml", "security.yml", "release.yml"]) {
    const content = await workflow(name);
    assert.doesNotMatch(content, /pull_request_target:/);
    for (const reference of content.matchAll(/uses:\s+([^\s]+)/g)) {
      assert.match(reference[1], /@(?:v\d+(?:\.\d+\.\d+)?|0\.\d+\.\d+)$/);
      assert.doesNotMatch(reference[1], /@(main|master|latest)$/);
    }
  }
});
