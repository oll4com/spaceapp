import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  applyPublicOverlay,
  auditPublicTree,
  contributorGuideProblems,
  documentLinkProblems,
  createPublicExport,
  isPublicExportPath,
  publicRootPackage,
  publicRepositoryOwnedFiles,
  runCli,
  sanitizePublicText,
  unlinkMissingTargets
} from "../public-export.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");

test("public text sanitization applies the private rules file and the generic rules", async () => {
  const rulesPath = join(await mkdtemp(join(tmpdir(), "spaceapp-private-rules-")), "rules.json");
  await writeFile(rulesPath, JSON.stringify({
    replacements: [{ pattern: "private\\.host\\.test", flags: "g", to: "spaceapp.example" }],
    rules: [{ rule: "private-hostname", pattern: "private\\.host\\.test", flags: "i" }]
  }));
  process.env.PUBLIC_EXPORT_PRIVATE_RULES = rulesPath;
  try {
    const fresh = await import("../public-export.mjs?private-rules");
    assert.equal(fresh.sanitizePublicText(`https://private.host.test on ${["VM", "207"].join("")}`), "https://spaceapp.example on public-host");
    const root = await mkdtemp(join(tmpdir(), "spaceapp-private-audit-"));
    await writeFile(join(root, "unsafe.txt"), "private.host.test\n");
    assert.deepEqual((await fresh.auditPublicTree(root)).findings.map((finding) => finding.rule), ["private-hostname"]);
  } finally {
    delete process.env.PUBLIC_EXPORT_PRIVATE_RULES;
  }
  // Without the private file the public script carries only generic rules.
  assert.equal(sanitizePublicText("private.host.test"), "private.host.test");
});

test("public export of a private tree fails without the private rules", async () => {
  const sourceRoot = await mkdtemp(join(tmpdir(), "spaceapp-private-source-"));
  await assert.rejects(
    runCli(["--source", sourceRoot, "--verify"]),
    /PUBLIC_EXPORT_PRIVATE_RULES/
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
    `export const host = "${["VM", "100"].join("")}";\n`
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
    'export const host = "public-host";\n'
  );
  await assert.rejects(() => readFile(join(outputRoot, "AGENTS.md"), "utf8"), /ENOENT/);
  assert.equal((await auditPublicTree(outputRoot)).findings.length, 0);
});

test("public audit rejects credential-shaped values", async () => {
  const root = await mkdtemp(join(tmpdir(), "spaceapp-public-audit-"));
  await writeFile(
    join(root, "unsafe.txt"),
    `${["VM", "207"].join("")} ${["gh", "p_abcdefghijklmnopqrstuvwxyz1234567890ABCD"].join("")}\n`
  );

  const result = await auditPublicTree(root);

  assert.deepEqual(
    result.findings.map((finding) => finding.rule),
    ["private-vm-identifier", "github-token"]
  );
});

test("public path policy exports application tests except the reviewed private-only ones", () => {
  // Review F15 (2026-10-14): every app and package test is public unless it cannot pass outside
  // the private environment; scripts/public-test-exclusions.json names each one with its reason.
  assert.equal(isPublicExportPath("apps/api/tests/private-runtime.test.ts"), true);
  assert.equal(isPublicExportPath("packages/runtime/tests/store.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/cli-runtimes.test.ts"), false);
  assert.equal(isPublicExportPath("apps/web/tests/public-deployment-config.test.ts"), false);
  assert.equal(isPublicExportPath("scripts/tests/private-ops.test.mjs"), false);
  assert.equal(isPublicExportPath("packages/db/tests/new-feature-repository-postgres.test.ts"), false);
  assert.equal(isPublicExportPath("apps/api/tests/postgres-free.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/constant-time-token.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/route-rate-limits.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/setup.test.ts"), true);
  assert.equal(isPublicExportPath("apps/api/tests/storage-warning.test.ts"), true);
  assert.equal(isPublicExportPath("apps/web/tests/clipboard-html.test.ts"), true);
  assert.equal(isPublicExportPath("apps/web/tests/setup-testing-library.ts"), true);
  assert.equal(isPublicExportPath("packages/runtime/tests/public-defaults.test.ts"), true);
  assert.equal(isPublicExportPath("packages/run-spaceapp/tests/cli.test.mjs"), true);
  assert.equal(isPublicExportPath("docs/legal/cli-distribution-policy.json"), true);
  assert.equal(isPublicExportPath("agent-skills/space-superpowers/SKILL.md"), true);
  assert.equal(isPublicExportPath("SUPPORT.md"), true);
  for (const path of [
    ".trivyignore",
    "scripts/container-image-size-budget.mjs",
    "scripts/release-version.mjs",
    "scripts/tests/portable-backup-restore.test.mjs",
    "scripts/tests/container-image-size-budget.test.mjs",
    "scripts/tests/public-compose-config.test.mjs",
    "scripts/tests/public-docker-distribution.test.mjs",
    "scripts/tests/public-export.test.mjs",
    "scripts/tests/public-package-metadata.test.mjs",
    "scripts/tests/public-release-readiness.test.mjs",
    "scripts/tests/public-suite.test.mjs",
    "scripts/tests/public-workflows.test.mjs",
    "scripts/tests/release-version.test.mjs",
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

test("public overlay preserves dynamic model discovery and removes anonymous owner login", () => {
  assert.equal(applyPublicOverlay("apps/api/src/cli-runtime-descriptors.ts", 'defaultModelId: "big-pickle"'), 'defaultModelId: null');
  const bootstrap='before\n    if (!user && !request.cookies["space_logged_out"]) { user = owner; }\n    if (user && store.getControlActor) after';
  const publicAuth=applyPublicOverlay("apps/api/src/app.ts", bootstrap);
  assert.doesNotMatch(publicAuth, /user = owner/);
  assert.match(publicAuth, /if \(user && store.getControlActor\)/);
  assert.throws(() => applyPublicOverlay("apps/api/src/app.ts", bootstrap.split('    if (user &&')[0]), /Review changed auth/);
});

test('public overlay replaces embedded Antigravity OAuth clients with owner environment settings', () => {
  const source=['export const ANTIGRAVITY_CLIENT_ID = "embedded-client";','export const ANTIGRAVITY_CLIENT_SECRET = "embedded-secret";'].join('\n');
  for(const path of ['apps/api/src/antigravity-usage-services.ts','packages/gateway/src/providers/antigravity/oauth.ts']){
   const result=applyPublicOverlay(path,source);
   assert.ok(result.includes('process.env.ANTIGRAVITY_CLIENT_ID ?? ""'),path);
   assert.ok(result.includes('process.env.ANTIGRAVITY_CLIENT_SECRET ?? ""'),path);
   assert.ok(!result.includes('embedded-'),path);
  }
});

test('public audit rejects Google OAuth clients before publication', async () => {
  const root=await mkdtemp(join(tmpdir(),'spaceapp-oauth-audit-'));
  await writeFile(join(root,'unsafe.ts'),['123456789012-syntheticclient123456.apps.', 'googleusercontent.com ', 'GO', 'CSPX-syntheticSecret0123456789'].join(''));
  const findings=(await auditPublicTree(root)).findings.map(x=>x.rule);
  assert.ok(findings.includes('google-oauth-client-id'));
  assert.ok(findings.includes('google-oauth-client-secret'));
});

async function writeSourceTree(files) {
  const sourceRoot = await mkdtemp(join(tmpdir(), "spaceapp-public-scripts-source-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(sourceRoot, ...path.split("/").slice(0, -1)), { recursive: true });
    await writeFile(join(sourceRoot, ...path.split("/")), typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
  return { sourceRoot, trackedPaths: Object.keys(files) };
}

// Files the public repository maintains itself; root scripts may name them.
const publicRepositoryFiles = ["scripts/public-export.mjs", "scripts/tests/public-suite.test.mjs"];
const fileReferences = (command) => [...command.matchAll(/(?:^|\s)((?:scripts|deploy|docs|demos|starter-memory)\/[^\s"'&|;<>()]+)/g)].map((match) => match[1]);

test("every file named by the exported package.json scripts exists in the export file list", async () => {
  const { sourceRoot, trackedPaths } = await writeSourceTree({
    "package.json": {
      name: "space",
      private: true,
      scripts: {
        check: "npm run test:architecture && npm run build -w @space/contracts && npm run check -w @space/api",
        test: "npm run test:architecture && npm run test:deploy && npm run build -w @space/contracts && npm run test -w @space/contracts",
        "test:architecture": "node --test scripts/tests/domain-boundaries.test.mjs && node scripts/domain-boundaries.mjs",
        "test:deploy": "node --test scripts/tests/private-ops.test.mjs scripts/tests/contributor-smoke.test.mjs",
        "test:public": "node --test scripts/tests/public-suite.test.mjs && npm test -w @space/api -- setup.test.ts && npm test -w run-spaceapp",
        "public:export:verify": "node scripts/public-export.mjs --verify",
        "live:verify": "node scripts/private-live-guard.mjs --require-live-main",
        ops: "npm run live:verify && npm run hygiene:preflight",
        "hygiene:preflight": "node scripts/space-hygiene-check.mjs --preflight"
      }
    },
    "apps/api/package.json": { name: "@space/api" },
    "packages/contracts/package.json": { name: "@space/contracts" },
    "scripts/domain-boundaries.mjs": "export {};\n",
    "scripts/tests/domain-boundaries.test.mjs": "export {};\n",
    "scripts/tests/contributor-smoke.test.mjs": "export {};\n",
    "scripts/tests/private-ops.test.mjs": "export {};\n",
    "scripts/private-live-guard.mjs": "export {};\n",
    "scripts/space-hygiene-check.mjs": "export {};\n"
  });
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-scripts-output-")), "export");

  const result = await createPublicExport({
    sourceRoot,
    outputRoot,
    trackedPaths,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567"
  });
  const { scripts } = JSON.parse(await readFile(join(outputRoot, "package.json"), "utf8"));
  const exported = new Set([...result.manifest.files.map((file) => file.path), ...publicRepositoryFiles]);

  const missing = Object.entries(scripts).flatMap(([name, command]) =>
    fileReferences(command).filter((path) => !exported.has(path)).map((path) => `${name}: ${path}`));
  assert.deepEqual(missing, []);
  // The public tree carries only the public tests, so npm test runs that suite.
  assert.equal(scripts.test, "npm run test:public");
  assert.equal(scripts["test:deploy"], "node --test scripts/tests/contributor-smoke.test.mjs");
  assert.equal(scripts.check, "npm run test:architecture && npm run build -w @space/contracts && npm run check -w @space/api");
  assert.equal(scripts["live:verify"], undefined);
  assert.equal(scripts.ops, "npm run hygiene:preflight");
  assert.equal(scripts["public:export:verify"], "node scripts/public-export.mjs --verify");
});

test("public package scripts keep node --test flags and drop steps of removed scripts", () => {
  const { text, dropped } = publicRootPackage(JSON.stringify({ scripts: {
    unit: "node --test --test-concurrency=1 scripts/tests/a.test.mjs scripts/tests/private.test.mjs",
    private: "node scripts/private.mjs",
    chain: "npm run private && npm run unit"
  } }), { hasFile: (path) => !path.includes("private"), hasWorkspace: () => true });
  assert.deepEqual(JSON.parse(text).scripts, {
    unit: "node --test --test-concurrency=1 scripts/tests/a.test.mjs",
    chain: "npm run unit"
  });
  assert.deepEqual(dropped, ["private"]);
});

test("public export fails instead of shipping a script for a workspace the public tree lacks", async () => {
  const { sourceRoot, trackedPaths } = await writeSourceTree({
    "package.json": { name: "space", scripts: { build: "npm run build -w @space/desktop" } },
    "apps/desktop/package.json": { name: "@space/desktop" }
  });
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-workspace-output-")), "export");

  await assert.rejects(
    () => createPublicExport({ sourceRoot, outputRoot, trackedPaths, sourceCommit: "0123456789abcdef0123456789abcdef01234567" }),
    /missing workspace @space\/desktop/
  );
  await assert.rejects(() => stat(outputRoot), /ENOENT/);
});

test("public export fails when CONTRIBUTING sends contributors to a script or file the public tree lacks", async () => {
  const { sourceRoot, trackedPaths } = await writeSourceTree({
    "package.json": { name: "space", scripts: { "smoke:offline": "node scripts/private-smoke.mjs", check: "node scripts/space-hygiene-check.mjs" } },
    "scripts/private-smoke.mjs": "export {};\n",
    "scripts/space-hygiene-check.mjs": "export {};\n",
    "CONTRIBUTING.md": "# Contributing\n\n```sh\nELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci\nnpm run check\nnpm run smoke:offline\n```\n"
  });
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-guide-output-")), "export");

  await assert.rejects(
    () => createPublicExport({ sourceRoot, outputRoot, trackedPaths, sourceCommit: "0123456789abcdef0123456789abcdef01234567" }),
    /CONTRIBUTING[\s\S]*npm run smoke:offline/
  );
  await assert.rejects(() => stat(outputRoot), /ENOENT/);
  assert.deepEqual(
    contributorGuideProblems("See [quality](docs/quality/README.md) and [reference](docs/configuration-reference.md).\n", {}, (path) => path === "docs/configuration-reference.md"),
    ["CONTRIBUTING.md links to missing file: docs/quality/README.md"]
  );
});

test("the documented contributor path is exported", () => {
  for (const path of [
    "scripts/dev-stack.mjs",
    "scripts/dev-stack-native.mjs",
    "scripts/tests/dev-stack-native.test.mjs",
    "scripts/dev-stack-diagnostics.mjs",
    "scripts/tests/dev-stack-diagnostics.test.mjs",
    "scripts/dev-stack-state.mjs",
    "scripts/dev-stack-config.mjs",
    "scripts/dev-stack-process.mjs",
    "scripts/dev-stack-wrapper.mjs",
    "scripts/dev-stack-acceptance.mjs",
    "scripts/dev-stack-ci.mjs",
    "scripts/dev-stack-lifecycle.mjs",
    "scripts/dev-stack-browser.mjs",
    "scripts/dev-stack-reload.mjs",
    "scripts/tests/dev-stack-browser.test.mjs",
    "scripts/tests/dev-stack-reload.test.mjs",
    "scripts/tests/dev-stack-lifecycle.test.mjs",
    "scripts/tests/dev-stack-state.test.mjs",
    "scripts/tests/dev-stack-config.test.mjs",
    "scripts/tests/dev-stack-process.test.mjs",
    "scripts/tests/dev-stack-wrapper.test.mjs",
    "scripts/tests/dev-stack-acceptance.test.mjs",
    "scripts/tests/dev-stack-runner.test.mjs",
    ".github/workflows/dev-stack.yml",
    "scripts/contributor-smoke.mjs",
    "scripts/fixtures/offline-cli.mjs",
    "scripts/tests/contributor-smoke.test.mjs",
    "scripts/domain-boundaries.mjs",
    "scripts/tests/domain-boundaries.test.mjs",
    "docs/quality/domain-boundaries.json",
    "docs/configuration-reference.md",
    "eslint.config.mjs"
  ]) {
    assert.equal(isPublicExportPath(path), true, `${path} must be exported`);
  }
  // The quality evidence ships with the code it describes (review 2026-10-14).
  assert.equal(isPublicExportPath("docs/quality/README.md"), true);
  assert.equal(isPublicExportPath("docs/architecture.md"), true);
  assert.equal(isPublicExportPath("docs/internal-notes.md"), false);
  // The release workflow exports this repository itself and keeps its security model.
  assert.equal(isPublicExportPath("docs/security-model.md"), true);
});

test("a sync from the private source never replaces public-repository maintained files", async () => {
  const { sourceRoot, trackedPaths } = await writeSourceTree({
    "README.md": "# SpaceApp\n",
    "docs/security-model.md": "internal security model\n"
  });
  const fromPrivate = join(await mkdtemp(join(tmpdir(), "spaceapp-public-maintained-")), "export");
  const synced = await createPublicExport({ sourceRoot, outputRoot: fromPrivate, trackedPaths,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567", publicRepositoryFiles: new Set(["docs/security-model.md"]) });
  assert.equal(synced.manifest.files.some((file) => file.path === "docs/security-model.md"), false);
  // The release workflow exports the public repository itself: the file stays.
  const fromPublic = join(await mkdtemp(join(tmpdir(), "spaceapp-public-maintained-")), "export");
  const released = await createPublicExport({ sourceRoot, outputRoot: fromPublic, trackedPaths,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567" });
  assert.equal(released.manifest.files.some((file) => file.path === "docs/security-model.md"), true);
});

test("README links to files outside the public tree become their link text", () => {
  const readme = [
    "See [state ownership](docs/quality/state-ownership.md) and the",
    "[trust boundaries in the\narchitecture](docs/architecture.md#trust-boundaries).",
    "Read [CONTRIBUTING](CONTRIBUTING.md), the [guide](./docs/getting-started.md#install),",
    "[the site](https://spaceapp.example/docs/architecture.md), [top](#top) and the [skills](agent-skills/).",
    "![diagram](docs/images/internal.png)"
  ].join("\n");
  const has = (path) => ["CONTRIBUTING.md", "docs/getting-started.md", "agent-skills"].includes(path);
  assert.equal(unlinkMissingTargets("README.md", readme, has), [
    "See state ownership and the",
    "trust boundaries in the\narchitecture.",
    "Read [CONTRIBUTING](CONTRIBUTING.md), the [guide](./docs/getting-started.md#install),",
    "[the site](https://spaceapp.example/docs/architecture.md), [top](#top) and the [skills](agent-skills/).",
    "diagram"
  ].join("\n"));
  assert.deepEqual(documentLinkProblems("README.md", '<a href="LICENSE">x</a> [a](docs/architecture.md)', (path) => path === "LICENSE"),
    ["README.md links to missing file: docs/architecture.md"]);
});

test("the exported README never links to internal documents and the export checks it", async () => {
  const { sourceRoot, trackedPaths } = await writeSourceTree({
    "README.md": "# SpaceApp\n\nSee the [architecture](docs/architecture.md#trust-boundaries), the\n[notes](docs/internal-notes.md), the [security model](docs/security-model.md) and [CONTRIBUTING](CONTRIBUTING.md).\n",
    "CONTRIBUTING.md": "# Contributing\n\nSee the [README](README.md).\n",
    "docs/architecture.md": "See the [failure matrix](quality/failure-matrix.md).\n",
    "docs/internal-notes.md": "internal\n"
  });
  const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-readme-output-")), "export");

  const result = await createPublicExport({
    sourceRoot,
    outputRoot,
    trackedPaths,
    sourceCommit: "0123456789abcdef0123456789abcdef01234567",
    // docs/security-model.md is owned by the public repository.
    publicRepositoryFiles: new Set(["docs/security-model.md", "packages/run-spaceapp/package.json"])
  });

  const readme = await readFile(join(outputRoot, "README.md"), "utf8");
  assert.equal(readme, "# SpaceApp\n\nSee the [architecture](docs/architecture.md#trust-boundaries), the\nnotes, the [security model](docs/security-model.md) and [CONTRIBUTING](CONTRIBUTING.md).\n");
  const exported = new Set(result.manifest.files.map((file) => file.path));
  assert.equal(exported.has("docs/architecture.md"), true);
  assert.equal(exported.has("docs/internal-notes.md"), false);
  // Exported documents keep the text of links to files that are not exported.
  assert.equal(await readFile(join(outputRoot, "docs/architecture.md"), "utf8"), "See the failure matrix.\n");
  assert.deepEqual(documentLinkProblems("README.md", readme,
    (path) => exported.has(path) || path === "docs/security-model.md"), []);
});

test("the export fails when README or CONTRIBUTING still links to a missing file", async () => {
  for (const [file, text] of [
    ["README.md", '# SpaceApp\n\n<a href="docs/quality/README.md">quality</a>\n'],
    ["CONTRIBUTING.md", "# Contributing\n\nResults: [quality](docs/quality/README.md).\n"]
  ]) {
    const { sourceRoot, trackedPaths } = await writeSourceTree({ [file]: text });
    const outputRoot = join(await mkdtemp(join(tmpdir(), "spaceapp-public-links-output-")), "export");
    await assert.rejects(
      () => createPublicExport({ sourceRoot, outputRoot, trackedPaths, sourceCommit: "0123456789abcdef0123456789abcdef01234567", publicRepositoryFiles: new Set() }),
      new RegExp(`${file.replace(".", "\\.")} links to missing file: docs/quality/README\\.md`)
    );
    await assert.rejects(() => stat(outputRoot), /ENOENT/);
  }
});

// Needs a Git checkout; the release workflow runs the suite in an exported tree without .git.
test("public-repository files are tracked files the previous export did not ship", { skip: !existsSync(join(repoRoot, ".git")) }, async () => {
  const owned = await publicRepositoryOwnedFiles(repoRoot);
  const manifest = JSON.parse(await readFile(join(repoRoot, "PUBLIC_EXPORT_MANIFEST.json"), "utf8"));
  assert.ok(owned.has("packages/run-spaceapp/package.json"));
  assert.ok(owned.has("scripts/public-export.mjs"));
  for (const file of manifest.files) assert.equal(owned.has(file.path), false, file.path);
});
