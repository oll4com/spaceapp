// Longniang, 2026-10-28: guard the complete public contributor stack and its CI pins.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { createPublicExport, isPublicExportPath } from "../public-export.mjs";

const root = resolve(import.meta.dirname, "../..");
const stackTests = [
  "dev-stack-state.test.mjs",
  "dev-stack-processes.test.mjs",
  "dev-stack-runtime.test.mjs",
  "dev-stack-supervisor.test.mjs"
];

async function stackPaths() {
  return [
    "scripts/dev-stack.mjs",
    ...(await readdir(join(root, "scripts/dev-stack")))
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => `scripts/dev-stack/${name}`),
    ...stackTests.map((name) => `scripts/tests/${name}`),
    "docs/contributing-dev-stack.md"
  ];
}

test("public export retains the complete contributor stack and dev:stack command", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "spaceapp-dev-stack-export-"));
  try {
    const paths = await stackPaths();
    for (const path of paths) assert.equal(isPublicExportPath(path), true, path);
    const workspaceManifests = [];
    for (const directory of ["apps", "packages"]) {
      for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        if (entry.isDirectory()) workspaceManifests.push(`${directory}/${entry.name}/package.json`);
      }
    }
    const outputRoot = join(temporary, "export");
    const result = await createPublicExport({
      sourceRoot: root,
      outputRoot,
      trackedPaths: ["package.json", ...workspaceManifests, ...paths],
      sourceCommit: "0123456789abcdef0123456789abcdef01234567"
    });
    const exportedPaths = new Set(result.manifest.files.map(({ path }) => path));
    for (const path of paths) {
      assert.ok(exportedPaths.has(path), `${path} must survive a real export`);
      const exported = await readFile(join(outputRoot, path), "utf8");
      if (!path.endsWith(".md")) {
        assert.equal(exported, await readFile(join(root, path), "utf8"), path);
      }
    }
    const sourcePackage = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    const exportedPackage = JSON.parse(await readFile(join(outputRoot, "package.json"), "utf8"));
    assert.equal(sourcePackage.scripts["dev:stack"], "node scripts/dev-stack.mjs");
    assert.equal(exportedPackage.scripts["dev:stack"], sourcePackage.scripts["dev:stack"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("the public suite explicitly imports all four contributor stack test modules", async () => {
  const suite = await readFile(join(root, "scripts/tests/public-suite.test.mjs"), "utf8");
  const imports = [...suite.matchAll(/^import ["']\.\/([^"']+)["'];$/gm)]
    .map((match) => match[1]);
  for (const name of stackTests) {
    assert.equal(imports.filter((entry) => entry === name).length, 1, name);
  }
});

test("contributor CI follows the repository Node version and artifact action pin", async () => {
  const workflow = await readFile(join(root, ".github/workflows/dev-stack.yml"), "utf8");
  const release = await readFile(join(root, ".github/workflows/release.yml"), "utf8");
  const expected = release.match(/actions\/upload-artifact@([0-9a-f]{40})/);
  assert.ok(expected, "the release workflow must provide the reviewed artifact action pin");
  const actual = [...workflow.matchAll(/actions\/upload-artifact@([0-9a-f]{40})/g)];
  assert.ok(actual.length > 0);
  for (const match of actual) assert.equal(match[1], expected[1]);
  assert.match(workflow, /node-version-file:\s*\.nvmrc/);
  assert.doesNotMatch(workflow, /\bnode-version:/);
});

// Longniang, 2026-10-28: exercise the actual CI sanitizer against token and child-log fixtures.
test("contributor CI uploads only sanitized supervisor console output", async () => {
  const workflow = await readFile(join(root, ".github/workflows/dev-stack.yml"), "utf8");
  assert.match(workflow, /npm run dev:stack > "\$RUNNER_TEMP\/dev-stack\.log"/);
  assert.match(workflow, /\$\{\{ runner\.temp \}\}\/dev-stack-console\.txt/);
  assert.doesNotMatch(workflow.slice(workflow.indexOf("Publish sanitized acceptance record")), /\/dev-stack\.log/);
  const sanitizer = workflow.match(/name: Save sanitized supervisor console[\s\S]*?node --input-type=module <<'NODE'\n([\s\S]*?)          NODE/);
  assert.ok(sanitizer, "the console sanitizer must run even when acceptance fails");
  assert.match(sanitizer[0], /if: always\(\)/);
  const temporary = await mkdtemp(join(tmpdir(), "spaceapp-console-proof-"));
  try {
    await writeFile(join(temporary, "dev-stack.log"), [
      "> spaceapp dev:stack",
      "[worker] child output must stay private",
      "[dev-stack] Waiting for strict readiness...",
      "[dev-stack] Owner setup token: console-test-secret",
      "Owner setup token: unprefixed-test-secret",
      "[dev-stack] Ready: http://127.0.0.1:14911"
    ].join("\n"));
    execFileSync(process.execPath, ["--input-type=module"], {
      input: sanitizer[1],
      env: { ...process.env, RUNNER_TEMP: temporary },
      stdio: ["pipe", "pipe", "pipe"]
    });
    assert.equal(await readFile(join(temporary, "dev-stack-console.txt"), "utf8"), [
      "[dev-stack] Waiting for strict readiness...",
      "[dev-stack] Owner setup token: [REDACTED]",
      "[dev-stack] Ready: http://127.0.0.1:14911",
      ""
    ].join("\n"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
