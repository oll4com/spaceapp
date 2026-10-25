import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const unqualifiedNpxCommand = /(^|[^\w-])npx --yes run-spaceapp(?:$|[^\w@])/;
const globalFollowUpCommand =
  /(^|[^\w-])spaceapp (?:doctor|status|uninstall|credentials)\b/;

const publicTestModules = [
  "publish-npm-candidate.test.mjs",
  "container-image-size-budget.test.mjs",
  "mcp-hono-compatibility.test.mjs",
  "portable-backup-restore.test.mjs",
  "published-container-verification.test.mjs",
  "shipped-image-evidence.test.mjs",
  "public-compose-config.test.mjs",
  "public-credential-install.test.mjs",
  "embed-image-lock.test.mjs",
  "provider-install.test.mjs",
  "public-docker-distribution.test.mjs",
  "public-export.test.mjs",
  "public-package-metadata.test.mjs",
  "public-release-readiness.test.mjs",
  "public-workflows.test.mjs",
  "release-artifact-preflight.test.mjs",
  "release-version.test.mjs",
  "reset-owner-password.test.mjs",
  "rotate-owner-setup-token.test.mjs",
  "trivy-report-summary.test.mjs",
  "verify-export-provenance.test.mjs",
  "dev-stack.test.mjs"
];

async function packageFiles(directory) {
  const entries = await readdir(join(root, directory), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, directory, entry.name, "package.json"));
}

test("public command guards reject forbidden commands inside inline Markdown", () => {
  assert.match("Use `npx --yes run-spaceapp` to continue.", unqualifiedNpxCommand);
  assert.match("Use `spaceapp doctor` to diagnose it.", globalFollowUpCommand);
});

test("active documentation routes host-root through the current launcher", async () => {
  for (const path of [
    "README.md",
    "packages/run-spaceapp/README.md",
    "docs/getting-started.md",
    "docs/operations.md",
    "docs/security-model.md"
  ]) {
    const content = await readFile(join(root, path), "utf8");
    assert.match(
      content,
      /npx --yes run-spaceapp@latest install --access host-root/,
      path
    );
    assert.doesNotMatch(content, /run-spaceapp@personal/, path);
    assert.doesNotMatch(
      content,
      /npx --yes run-spaceapp@0\.1\.15-hostroot\.0 install --access host-root/,
      path
    );
  }
});

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
    "@space/streaming",
    "@space/opencode-control",
    "@space/memory-graph",
    "@space/browser-host",
    "@space/cli-host",
    "@space/codex-app-server",
    "@space/runtime",
    "@space/db",
    "@space/gateway"
  ];

  assert.match(
    rootPackage.scripts["test:public"],
    /^node --test scripts\/tests\/public-suite\.test\.mjs && /
  );
  // Every internal API dependency is built in dependency order before the
  // public API tests; the API depends on @space/gateway since the gateway merge.
  assert.deepEqual(localApiDependencies.filter((name) => !publicBuildOrder.includes(name)), []);
  let previousBuildIndex = -1;
  for (const dependency of publicBuildOrder.filter((name) => localApiDependencies.includes(name))) {
    const buildIndex = rootPackage.scripts["test:public"].indexOf(
      `npm run build -w ${dependency}`
    );
    assert.ok(
      buildIndex > previousBuildIndex,
      `${dependency} must be built in dependency order before the public API tests`
    );
    previousBuildIndex = buildIndex;
  }
  // Review F15: after the builds, every workspace runs its whole exported suite.
  assert.match(rootPackage.scripts["test:public"], / && npm test --workspaces --if-present$/);
  assert.deepEqual(importedModules, publicTestModules);
});

test("public repository preserves application and launcher licenses with only the launcher publishable", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const workspaceFiles = [
    ...(await packageFiles("apps")),
    ...(await packageFiles("packages"))
  ];

  assert.equal(rootPackage.private, true);
  assert.equal(rootPackage.license, "MIT");
  assert.equal(rootPackage.repository.url, "git+https://github.com/oll4com/spaceapp.git");

  const publishable = [];
  for (const file of workspaceFiles) {
    const manifest = JSON.parse(await readFile(file, "utf8"));
    assert.equal(manifest.license, "MIT", `${file} must declare the MIT License`);
    if (manifest.private !== true) {
      publishable.push({
        name: manifest.name,
        version: manifest.version,
        bin: manifest.bin
      });
    }
  }

  const launcherPackage = JSON.parse(
    await readFile(join(root, "packages", "run-spaceapp", "package.json"), "utf8")
  );
  assert.deepEqual(publishable, [{
    name: "run-spaceapp",
    version: launcherPackage.version,
    bin: {
      spaceapp: "bin/spaceapp.mjs",
      "run-spaceapp": "bin/spaceapp.mjs"
    }
  }]);
  const runtimeVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
  assert.match(launcherPackage.spaceappRuntimeVersion, runtimeVersionPattern);
  if (launcherPackage.spaceappRuntimeVersion === launcherPackage.version) {
    // Full releases pin the runtime images at the launcher version with host-root enabled.
    assert.equal(launcherPackage.spaceappHostRootRuntimeCompatible, true);
  } else {
    // Launcher-only releases ship the launcher on existing runtime images:
    // host-root compatibility must be disabled (mirrors the release-readiness contract).
    assert.equal(launcherPackage.spaceappHostRootRuntimeCompatible, false);
  }
  assert.deepEqual(launcherPackage.cpu, ["x64", "arm64"]);
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
  const workerRequire = createRequire(join(root, "apps", "worker", "package.json"));
  const cargoLock = await readFile(join(dirname(workerRequire.resolve("@temporalio/core-bridge/package.json")), "Cargo.lock"), "utf8");
  const expectedVersion = "1.24.0";

  assert.equal(apiPackage.dependencies["@temporalio/client"], expectedVersion);
  for (const name of [
    "@temporalio/activity",
    "@temporalio/client",
    "@temporalio/worker",
    "@temporalio/workflow"
  ]) {
    assert.equal(workerPackage.dependencies[name], expectedVersion);
  }
  const lockedTemporalPackages = Object.entries(lockfile.packages)
    .filter(([path]) => /node_modules\/@temporalio\/[^/]+$/.test(path));
  assert.ok(
    lockedTemporalPackages.some(([path]) => path.endsWith("/@temporalio/core-bridge"))
  );
  for (const [path, metadata] of lockedTemporalPackages) {
    assert.equal(metadata.version, expectedVersion, `${path} must use the reviewed SDK release`);
  }
  assert.equal(lockfile.packages["node_modules/protobufjs"].version, "7.6.5");

  const cargoPackages = [...cargoLock.matchAll(
    /\[\[package\]\]\r?\nname = "([^"]+)"\r?\nversion = "([^"]+)"/g
  )];
  const crateVersions = (name) =>
    cargoPackages
      .filter(([, packageName]) => packageName === name)
      .map(([, , version]) => version)
      .sort();

  assert.deepEqual(crateVersions("opentelemetry_sdk"), ["0.32.1"]);
  assert.deepEqual(crateVersions("rand"), ["0.10.1", "0.9.3"]);
  assert.deepEqual(crateVersions("tar"), ["0.4.46"]);
  assert.deepEqual(crateVersions("quinn-proto"), [], "Reviewed SDK removes the vulnerable HTTP/3 implementation");
});

test("MCP Node transport is forced to the reviewed Hono security release", async () => {
  const rootPackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  const lockfile = JSON.parse(
    await readFile(join(root, "package-lock.json"), "utf8")
  );

  assert.equal(rootPackage.overrides?.["@hono/node-server"], "2.0.12");
  assert.equal(
    lockfile.packages["node_modules/@hono/node-server"].version,
    "2.0.12"
  );
});

test("temporary vulnerability ignores are narrow, documented, and expiring", async () => {
  const ignoreFile = await readFile(join(root, ".trivyignore"), "utf8");
  const activeEntries = ignoreFile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  // An ignore that no longer matches is removed, not renewed (1.1.7, review INT5-C-F16): on 2026-10-19 Trivy 0.70.0 with
  // that day's database found only this rustls advisory in the 1.1.6 core, CLI and browser images and nothing in the source.
  assert.deepEqual(activeEntries, ["GHSA-2mjx-qc3c-rqvc exp:2026-11-10"]);
  assert.match(ignoreFile, /without TLS/i);
  assert.doesNotMatch(ignoreFile, /trustProxy/i);
});

test("public policy files are present and point security reports to a private channel", async () => {
  const license = await readFile(join(root, "LICENSE"), "utf8");
  const security = await readFile(join(root, "SECURITY.md"), "utf8");
  const packageManifest = JSON.parse(
    await readFile(join(root, "packages", "run-spaceapp", "package.json"), "utf8")
  );

  assert.match(license, /^MIT License$/m);
  assert.match(security, /security\/advisories\/new/);
  assert.match(security, /Do not open a public issue for a suspected vulnerability/i);
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    assert.ok(packageManifest.files.includes(file), `${file} must be included in the npm package`);
    await readFile(join(root, "packages", "run-spaceapp", file), "utf8");
  }
});

test("every THIRD_PARTY_LICENSES file the code names ships in the tree, the images and the notices (Claude review 1.1.7 F5)", async () => {
  const { readdir } = await import("node:fs/promises");
  const shipped = new Set(await readdir(join(root, "THIRD_PARTY_LICENSES")));
  const named = new Set();
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (/\.(?:ts|tsx|mjs|js|md)$/.test(entry.name)) {
        for (const match of (await readFile(path, "utf8")).matchAll(/THIRD_PARTY_LICENSES\/([\w.-]+\.txt)/g)) named.add(match[1]);
      }
    }
  };
  for (const dir of ["apps", "packages"]) await walk(join(root, dir));
  assert.ok(named.size >= 3, [...named].join(", "));
  for (const name of named) assert.ok(shipped.has(name), `THIRD_PARTY_LICENSES/${name} is named in the code but missing`);
  const dockerfile = await readFile(join(root, "Dockerfile"), "utf8");
  assert.match(dockerfile, /^COPY --from=build --chown=spaceapp:spaceapp \/app\/THIRD_PARTY_LICENSES \.\/THIRD_PARTY_LICENSES$/m);
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  for (const name of shipped) assert.match(notices, new RegExp(`THIRD_PARTY_LICENSES/${name.replace(".", "\\.")}`), name);
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
  const cleanRoom = await readFile(
    join(root, "docs", "clean-room-testing.md"),
    "utf8"
  );
  const operations = await readFile(join(root, "docs", "operations.md"), "utf8");
  const cliProviders = await readFile(
    join(root, "docs", "cli-providers.md"),
    "utf8"
  );
  const publicRelease = await readFile(
    join(root, "docs", "public-release.md"),
    "utf8"
  );
  const securityModel = await readFile(
    join(root, "docs", "security-model.md"),
    "utf8"
  );
  const universalPrefix = "npx --yes run-spaceapp@latest";
  const universalCommand = `${universalPrefix} install`;

  for (const content of [readme, gettingStarted, packageReadme]) {
    assert.match(
      content,
      new RegExp(universalCommand.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    );
    assert.match(content, /Docker.*(?:automatically|automatic)/is);
    assert.doesNotMatch(content, /@alpha|0\.1\.0-alpha|public alpha/i);
  }
  for (const content of [
    readme,
    gettingStarted,
    packageReadme,
    cleanRoom,
    operations,
    cliProviders,
    publicRelease,
    securityModel
  ]) {
    assert.doesNotMatch(content, unqualifiedNpxCommand);
  }
  for (const content of [
    readme,
    gettingStarted,
    packageReadme,
    operations,
    cliProviders
  ]) {
    assert.doesNotMatch(content, globalFollowUpCommand);
  }
  const followUpExamples = [readme, gettingStarted, operations, cliProviders].join("\n");
  for (const command of ["doctor", "status", "uninstall", "credentials"]) {
    assert.match(followUpExamples, new RegExp(`${universalPrefix.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    )} ${command}\\b`));
  }
  for (const heading of ["Linux", "macOS", "Windows 11 — Command Prompt"]) {
    assert.match(gettingStarted, new RegExp(`^## ${heading}$`, "m"));
  }
  assert.match(gettingStarted, /Restricted/);
  assert.match(gettingStarted, /npx\.cmd/);
  assert.match(gettingStarted, /8 GB/);
  assert.match(gettingStarted, /6\.5 GiB/);
  for (const profile of ["small", "medium", "large"]) assert.match(gettingStarted, new RegExp(`--profile ${profile}`));
  assert.match(gettingStarted, /Upgrades require only missing image layers/);
  assert.match(gettingStarted, /does\s+not preallocate/i);
  assert.match(gettingStarted, /WSL2/);
  assert.match(gettingStarted, /Windows Package Manager/);
  assert.match(gettingStarted, /hash-pinned/i);
  assert.match(gettingStarted, /verifies\s+its\s+Authenticode\s+signature/i);
  assert.match(gettingStarted, /verifies\s+its code signature/i);
  assert.match(gettingStarted, /group grants root-level privileges/i);
  assert.match(
    gettingStarted,
    /npx --yes run-spaceapp@latest install --access host-root/
  );
  assert.match(gettingStarted, /--access isolated/);
  assert.match(gettingStarted, /equivalent to\s+host-root\s+file access/i);
  assert.match(
    packageReadme,
    /run-spaceapp@latest install --access host-root/
  );
  assert.match(packageReadme, /Host-root is supported only on Linux/);
  for (const command of [
    "provider install claude",
    "help",
    "owner rotate-setup-token",
    "doctor",
    "status",
    "credentials list",
    "uninstall"
  ]) {
    assert.match(
      packageReadme,
      new RegExp(
        `npx --yes run-spaceapp@(personal|latest) ${command.replace(
          /[.*+?^${}()|[\]\\]/g,
          "\\$&"
        )}`
      )
    );
  }
  assert.match(readme, /run-spaceapp@latest owner rotate-setup-token/);
  assert.match(
    operations,
    /run-spaceapp@latest rollback[\s\S]*run-spaceapp@latest status/
  );
  assert.match(cleanRoom, /id -u[\s\S]*\b0\b/);
  assert.match(securityModel, /host-root[\s\S]*\/host[\s\S]*destroy the operating system/i);
});

test("the public release rollback restores both stable npm dist-tags", async () => {
  const runbook = await readFile(join(root, "docs", "public-release.md"), "utf8");

  assert.match(runbook, /npm dist-tag add run-spaceapp@0\.1\.12 latest/);
  assert.match(runbook, /npm dist-tag add run-spaceapp@0\.1\.12 next/);
  assert.match(runbook, /npm view run-spaceapp dist-tags --json/);
  assert.match(runbook, /exact version artifacts\s+remain immutable/i);
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
  const optionalProviders = await readFile(join(root, "deploy/docker/provider-install.mjs"), "utf8");
  const notices = await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  const packages = [
    "@openai/codex@0.145.0",
    "@google/gemini-cli@0.52.0",
    "@opencode/cli@2.0.32",
    "@qwen-code/qwen-code@0.20.1",
    "@moonshot-ai/kimi-code@0.29.0",
    "@xai-official/grok@0.2.111",
    "autohand-cli@0.9.3",
    "@github/copilot@1.0.78",
    "run-deepseek-cli@0.1.1"
  ];

  for (const packageSpec of packages) {
    assert.match(packageSpec.startsWith("@opencode/cli") ? dockerfile : optionalProviders, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(notices, new RegExp(packageSpec.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(optionalProviders, /downloads\.cursor\.com\/lab\/2026\.07\.23-e383d2b\/linux\/\$\{process\.arch\}\/agent-cli-package\.tar\.gz/);
  assert.match(notices, /2026\.07\.23-e383d2b/);
  assert.match(notices, /@anysphere\/agent-cli-runtime/);
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
