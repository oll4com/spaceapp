import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const publicTestModules = [
  "container-image-size-budget.test.mjs",
  "portable-backup-restore.test.mjs",
  "public-compose-config.test.mjs",
  "public-docker-distribution.test.mjs",
  "public-export.test.mjs",
  "public-package-metadata.test.mjs",
  "public-release-readiness.test.mjs",
  "public-workflows.test.mjs",
  "reset-owner-password.test.mjs",
  "rotate-owner-setup-token.test.mjs"
];

async function packageFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, directory, entry.name, "package.json"));
}

test("public test command uses a portable one-file suite that imports every public test", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const apiPackage = JSON.parse(
    await readFile(join(root, "apps", "api", "package.json"), "utf8")
  );
  const suite = await readFile(
    join(root, "scripts", "tests", "public-suite.test.mjs"),
    "utf8"
  );
  const importedModules = Array.from(
    suite.matchAll(/^import "\.\/([^"]+)";$/gm),
    (match) => match[1]
  );
  const localApiDependencies = Object.keys(apiPackage.dependencies)
    .filter((name) => name.startsWith("@space/"))
    .sort();
  const publicBuildOrder = [
    "@space/contracts",
    "@space/memory-graph",
    "@space/browser-host",
    "@space/cli-host",
    "@space/codex-app-server",
    "@space/runtime",
    "@space/db"
  ];

  assert.match(
    rootPackage.scripts["test:public"],
    /^node --test scripts\/tests\/public-suite\.test\.mjs && /
  );
  assert.deepEqual([...publicBuildOrder].sort(), localApiDependencies);
  let previousBuildIndex = -1;
  for (const dependency of publicBuildOrder) {
    const buildIndex = rootPackage.scripts["test:public"].indexOf(
      `npm run build -w ${dependency}`
    );
    assert.ok(
      buildIndex > previousBuildIndex,
      `${dependency} must be built in dependency order before the public API tests`
    );
    previousBuildIndex = buildIndex;
  }
  for (const testFile of [
    "cli-runtime-descriptors.test.ts",
    "constant-time-token.test.ts",
    "owner-setup-bootstrap.test.ts",
    "route-rate-limits.test.ts",
    "setup.test.ts",
    "clipboard-html.test.ts",
    "owner-setup.test.tsx"
  ]) {
    assert.match(rootPackage.scripts["test:public"], new RegExp(testFile.replaceAll(".", "\\.")));
  }
  assert.deepEqual(importedModules, publicTestModules);
});

test("public repository metadata declares Apache-2.0 with only the launcher publishable", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const workspaceFiles = [
    ...(await packageFiles("apps")),
    ...(await packageFiles("packages"))
  ];

  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.license, "Apache-2.0");
  assert.equal(rootPackage.repository.url, "git+https://github.com/oll4com/spaceapp.git");

  const publishable = [];
  for (const file of workspaceFiles) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    assert.equal(manifest.license, "Apache-2.0", `${file} must declare the repository license`);
    if (manifest.private !== true) {
      publishable.push({
        name: manifest.name,
        version: manifest.version,
        bin: manifest.bin
      });
    }
  }

  assert.deepEqual(publishable, [{
    name: "run-spaceapp",
    version: "0.1.2",
    bin: { spaceapp: "bin/spaceapp.mjs" }
  }]);
  const launcherPackage = JSON.parse(
    await readFile(join(root, "packages", "run-spaceapp", "package.json"), "utf8")
  );
  assert.equal(launcherPackage.publishConfig.tag, undefined);
});

test("Temporal dependencies use SDK releases with patched transitive packages", async () => {
  const apiPackage = JSON.parse(
    await readFile(join(root, "apps", "api", "package.json"), "utf8")
  );
  const workerPackage = JSON.parse(
    await readFile(join(root, "apps", "worker", "package.json"), "utf8")
  );
  const lockfile = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8")
  );
  const expectedVersion = "1.20.3";

  assert.equal(apiPackage.dependencies["@temporalio/client"], expectedVersion);
  for (const name of [
    "@temporalio/activity",
    "@temporalio/client",
    "@temporalio/worker",
    "@temporalio/workflow"
  ]) {
    assert.equal(workerPackage.dependencies[name], expectedVersion);
  }
  assert.equal(
    lockfile.packages["node_modules/@temporalio/core-bridge"].version,
    expectedVersion
  );
  assert.equal(lockfile.packages["node_modules/protobufjs"].version, "7.6.5");
});

test("public policy files are present and point security reports to a private channel", async () => {
  const license = await readFile(join(root, "LICENSE"), "utf8");
  const security = await readFile(join(root, "SECURITY.md"), "utf8");
  const packageManifest = JSON.parse(
    await readFile(join(root, "packages", "run-spaceapp", "package.json"), "utf8")
  );

  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(security, /security\/advisories\/new/);
  assert.match(security, /Do not open a public issue for a suspected vulnerability/i);
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(packageManifest.files.includes(file), `${file} must be included in the npm package`);
    await readFile(join(root, "packages", "run-spaceapp", file), "utf8");
  }
});

test("public docs provide one-command installation for Linux, macOS, and Windows", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  const gettingStarted = await readFile(
    join(root, "docs", "getting-started.md"),
    "utf8"
  );
  const packageReadme = await readFile(
    join(root, "packages", "run-spaceapp", "README.md"),
    "utf8"
  );
  const unixCommand = "npm install -g run-spaceapp && spaceapp install";
  const windowsCommand =
    "npm install -g run-spaceapp; if ($LASTEXITCODE -eq 0) { spaceapp install }";

  for (const content of [readme, gettingStarted, packageReadme]) {
    assert.match(content, new RegExp(unixCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(content, new RegExp(windowsCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(content, /@alpha|0\.1\.0-alpha|public alpha/i);
  }
  for (const heading of ["Linux", "macOS", "Windows 11 — PowerShell"]) {
    assert.match(gettingStarted, new RegExp(`^## ${heading}$`, "m"));
  }
  assert.match(gettingStarted, /8 GB/);
  assert.match(gettingStarted, /15 GiB/);
  assert.match(gettingStarted, /--profile light/);
  assert.match(gettingStarted, /does\s+not preallocate/i);
  assert.match(gettingStarted, /WSL2/);
});

test("public community files include support and structured contribution intake", async () => {
  for (const path of [
    "SUPPORT.md",
    ".github/ISSUE_TEMPLATE/bug_report.yml",
    ".github/ISSUE_TEMPLATE/feature_request.yml",
    ".github/ISSUE_TEMPLATE/config.yml",
    ".github/PULL_REQUEST_TEMPLATE.md"
  ]) {
    await readFile(join(root, path), "utf8");
  }
  const support = await readFile(join(root, "SUPPORT.md"), "utf8");
  const issueConfig = await readFile(
    join(root, ".github", "ISSUE_TEMPLATE", "config.yml"),
    "utf8"
  );

  assert.match(support, /security\/advisories\/new/);
  assert.match(support, /never include credentials/i);
  assert.match(issueConfig, /security\/advisories\/new/);
});

test("third-party notices cover every pinned CLI and the experimental DeepSeek boundary", async () => {
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const packages = [
    "@openai/codex@0.145.0",
    "@google/gemini-cli@0.52.0",
    "opencode-ai@1.18.4",
    "@qwen-code/qwen-code@0.20.1",
    "@moonshot-ai/kimi-code@0.29.0",
    "@xai-official/grok@0.2.111",
    "run-deepseek-cli@0.1.1"
  ];

  for (const packageSpec of packages) {
    assert.match(dockerfile, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(notices, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(dockerfile, /@anthropic-ai\/claude-code/);
  assert.match(notices, /Claude Code[\s\S]*not included in published SpaceApp images/i);
  assert.match(notices, /Claude Code[\s\S]*owner-initiated/i);
  assert.match(notices, /DeepSeek[\s\S]*community\/experimental[\s\S]*not an official DeepSeek CLI/i);
});

test("the launcher executable is explicitly included despite the runtime bin ignore", async () => {
  const gitignore = await readFile(join(root, ".gitignore"), "utf8");
  const hygiene = await readFile(join(root, "scripts", "space-hygiene-check.mjs"), "utf8");
  const executable = await readFile(
    join(root, "packages", "run-spaceapp", "bin", "spaceapp.mjs"),
    "utf8"
  );

  assert.match(gitignore, /!packages\/run-spaceapp\/bin\//);
  assert.match(gitignore, /!packages\/run-spaceapp\/bin\/spaceapp\.mjs/);
  assert.match(hygiene, /"packages\/run-spaceapp\/bin\/spaceapp\.mjs"/);
  assert.match(executable, /^#!\/usr\/bin\/env node/);
  assert.match(executable, /run\(process\.argv\.slice\(2\)\)/);
});
