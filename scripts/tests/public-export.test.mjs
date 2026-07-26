import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  auditPublicTree,
  createPublicExport,
  isPublicExportPath,
  sanitizePublicText
} from "../public-export.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

test("public text sanitization replaces private infrastructure markers", () => {
  const privateInput = [
    ["https://space.", "oll4.com:4911"].join(""),
    ["/srv/", "space"].join(""),
    ["/home/", "proxmoxusr"].join(""),
    ["10.", "100.0.207"].join(""),
    ["Yun", "wu"].join(""),
    ["olla", ".gr"].join(""),
    ["/etc/docs/", "gemini_history.md"].join("")
  ].join(" ");
  const sanitized = sanitizePublicText(privateInput);

  assert.equal(
    sanitized,
    "http://127.0.0.1:4911 /opt/spaceapp /var/lib/spaceapp-user 192.0.2.207 Legacy example.invalid /opt/spaceapp/docs/gemini_history.md"
  );
});

test("public exporter and its regression suite remain byte-stable across exports", async () => {
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-exporter-")), "export");
  const paths = [
    "scripts/public-export.mjs",
    "scripts/tests/public-export.test.mjs"
  ];

  const result = await createPublicExport({
    sourceRoot: repoRoot,
    outputRoot,
    trackedPaths: paths,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567"
  });

  assert.equal(result.manifest.transformations, 0);
  for (const path of paths) {
    assert.equal(
      await readFile(join(outputRoot, path), "utf8"),
      await readFile(join(repoRoot, path), "utf8"),
      `${path} must not rewrite its own sanitization policy`
    );
  }
});

test("public export copies only allowlisted source and writes a clean manifest", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "spaceapp-public-source-"));
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-output-")), "export");
  const trackedPaths = [
    "README.md",
    "AGENTS.md",
    "apps/api/src/example.ts",
    "docs/getting-started.md"
  ];

  await mkdir(join(sourceRoot, "apps", "api", "src"), { recursive: true });
  await mkdir(join(sourceRoot, "docs"), { recursive: true });
  await writeFile(join(sourceRoot, "README.md"), "# SpaceApp\n");
  await writeFile(join(sourceRoot, "AGENTS.md"), "private operator policy\n");
  await writeFile(
    join(sourceRoot, "apps", "api", "src", "example.ts"),
    `export const root = "${["/srv/", "space"].join("")}";\n`
  );
  await writeFile(join(sourceRoot, "docs", "getting-started.md"), "# Start\n");

  const result = await createPublicExport({
    sourceRoot,
    outputRoot,
    trackedPaths,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567"
  });

  assert.equal(result.manifest.sourceCommit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(result.manifest.transformations, 1);
  assert.equal(
    await readFile(join(outputRoot, "apps", "api", "src", "example.ts"), "utf8"),
    'export const root = "/opt/spaceapp";\n'
  );
  await assert.rejects(() => readFile(join(outputRoot, "AGENTS.md"), "utf8"), /ENOENT/);
  assert.equal((await auditPublicTree(outputRoot)).findings.length, 0);
});

test("public audit rejects private markers and credential-shaped values", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-public-audit-"));
  await writeFile(
    join(root, "unsafe.txt"),
    `${["/home/", "proxmoxusr"].join("")} ${["gh", "p_abcdefghijklmnopqrstuvwxyz1234567890ABCD"].join("")}\n`
  );

  const result = await auditPublicTree(root);

  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ["private-home-path", "github-token"]
  );
});

test("public path policy excludes internal tests and keeps only reviewed public tests", () => {
  assert.equal(isPublicExportPath("apps/api/tests/private-runtime.test.ts"), false);
  assert.equal(isPublicExportPath("packages/runtime/tests/store.test.ts"), false);
  assert.equal(isPublicExportPath("apps/api/tests/cli-runtimes.test.ts"), false);
  assert.equal(isPublicExportPath("apps/web/tests/public-deployment-config.test.ts"), false);
  assert.equal(isPublicExportPath("apps/api/tests/constant-time-token.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/route-rate-limits.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/setup.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/storage-warning.test.ts"), true);
  assert.equal(isPublicExportPath("apps/web/tests/clipboard-html.test.ts"), true);
  assert.equal(isPublicExportPath("packages/runtime/tests/public-defaults.test.ts"), true);
  assert.equal(isPublicExportPath("packages/run-spaceapp/tests/cli.test.mjs"), true);
  assert.equal(isPublicExportPath("docs/legal/cli-distribution-policy.json"), true);
  assert.equal(isPublicExportPath("SUPPORT.md"), true);
  for (const path of [
    ".trivyignore",
    "scripts/container-image-size-budget.mjs",
    "scripts/tests/portable-backup-restore.test.mjs",
    "scripts/tests/container-image-size-budget.test.mjs",
    "scripts/tests/public-compose-config.test.mjs",
    "scripts/tests/public-docker-distribution.test.mjs",
    "scripts/tests/public-export.test.mjs",
    "scripts/tests/public-package-metadata.test.mjs",
    "scripts/tests/public-release-readiness.test.mjs",
    "scripts/tests/public-suite.test.mjs",
    "scripts/tests/public-workflows.test.mjs",
    "scripts/tests/reset-owner-password.test.mjs",
    "scripts/tests/rotate-owner-setup-token.test.mjs"
  ]) {
    assert.equal(isPublicExportPath(path), true, `${path} must be exported`);
  }
});

test("every public-suite import survives the sanitized export allowlist", async () => {
  const suite = await readFile(
    join(repoRoot, "scripts", "tests", "public-suite.test.mjs"),
    "utf8"
  );
  const importedTests = [...suite.matchAll(/^import "\.\/([^"]+)";$/gm)]
    .map((match) => `scripts/tests/${match[1]}`);

  assert.ok(importedTests.length > 0);
  for (const path of importedTests) {
    assert.equal(isPublicExportPath(path), true, `${path} must be exported`);
  }
});

test("public export rejects unreviewed binary files and removes partial output", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "spaceapp-public-binary-source-"));
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-binary-output-")), "export");
  const path = "apps/api/src/unreviewed.bin";
  await mkdir(join(sourceRoot, "apps", "api", "src"), { recursive: true });
  await writeFile(join(sourceRoot, path), Buffer.from([0, 1, 2, 3]));

  await assert.rejects(
    () => createPublicExport({
      sourceRoot,
      outputRoot,
      trackedPaths: [path],
      sourceCommit: "0123456789abcdef0123456789abcdef01234567"
    }),
    /unreviewed binary/i
  );
  await assert.rejects(() => stat(outputRoot), /ENOENT/);
});

test("public export rejects case-insensitive collisions and removes partial output", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "spaceapp-public-collision-source-"));
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-collision-output-")), "export");
  const first = "apps/api/src/Collision.ts";
  const second = "apps/api/src/collision.ts";
  await mkdir(join(sourceRoot, "apps", "api", "src"), { recursive: true });
  await writeFile(join(sourceRoot, first), "export const first = true;\n");
  await writeFile(join(sourceRoot, second), "export const second = true;\n");

  await assert.rejects(
    () => createPublicExport({
      sourceRoot,
      outputRoot,
      trackedPaths: [first, second],
      sourceCommit: "0123456789abcdef0123456789abcdef01234567"
    }),
    /path collision/i
  );
  await assert.rejects(() => stat(outputRoot), /ENOENT/);
});

test("public export binds worktree bytes to the declared Git object", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "spaceapp-public-object-source-"));
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-object-output-")), "export");
  await writeFile(join(sourceRoot, "README.md"), "# changed after HEAD\n");

  await assert.rejects(
    () => createPublicExport({
      sourceRoot,
      outputRoot,
      trackedPaths: ["README.md"],
      sourceCommit: "0123456789abcdef0123456789abcdef01234567",
      trackedMetadata: new Map([
        ["README.md", {
          mode: "100644",
          objectId: "0123456789abcdef0123456789abcdef01234567"
        }]
      ])
    }),
    /does not match/i
  );
  await assert.rejects(() => stat(outputRoot), /ENOENT/);
});
