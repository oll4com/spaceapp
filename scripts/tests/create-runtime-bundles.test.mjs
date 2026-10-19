import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createRuntimeBundles, includeWorkspaceNodeModules, runtimeWorkspaceSelectors } from "../create-runtime-bundles.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function writeJson(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeWorkspace(root, directory, name, dependencies = {}) {
  const workspace = path.join(root, directory);
  writeJson(path.join(workspace, "package.json"), {
    name,
    version: "1.0.0",
    type: "module",
    dependencies
  });
  mkdirSync(path.join(workspace, "dist"), { recursive: true });
  mkdirSync(path.join(workspace, "src"), { recursive: true });
  mkdirSync(path.join(workspace, "tests"), { recursive: true });
  writeFileSync(path.join(workspace, "dist", "index.js"), "export {};\n");
  writeFileSync(path.join(workspace, "src", "index.ts"), "export {};\n");
  writeFileSync(path.join(workspace, "tests", "index.test.js"), "test();\n");
  return workspace;
}

function makeRepository(root) {
  writeJson(path.join(root, "package.json"), {
    name: "fixture",
    private: true,
    workspaces: ["apps/*", "packages/*"]
  });

  const api = makeWorkspace(root, "apps/api", "@space/api", {
    "@space/browser-host": "1.0.0",
    "@space/cli-host-client": "1.0.0",
    "@space/db": "1.0.0",
    "@space/gateway": "1.0.0"
  });
  const web = makeWorkspace(root, "apps/web", "@space/web", {
    "@space/contracts": "1.0.0",
    "@space/icons": "1.0.0"
  });
  makeWorkspace(root, "apps/worker", "@space/worker", { "@space/db": "1.0.0" });
  makeWorkspace(root, "packages/browser-host", "@space/browser-host", { "@space/contracts": "1.0.0" });
  makeWorkspace(root, "packages/memory-graph", "@space/memory-graph", { "@space/contracts": "1.0.0" });
  makeWorkspace(root, "packages/runtime", "@space/runtime", {
    "@space/contracts": "1.0.0",
    "@space/memory-graph": "1.0.0"
  });
  makeWorkspace(root, "packages/cli-host", "@space/cli-host", { "@space/cli-host-client": "1.0.0" });
  makeWorkspace(root, "packages/cli-host-client", "@space/cli-host-client");
  makeWorkspace(root, "packages/contracts", "@space/contracts");
  const icons = makeWorkspace(root, "packages/icons", "@space/icons");
  rmSync(path.join(icons, "dist"), { recursive: true, force: true });
  const db = makeWorkspace(root, "packages/db", "@space/db", { "@space/contracts": "1.0.0" });
  const gateway = makeWorkspace(root, "packages/gateway", "@space/gateway", { "@space/db": "1.0.0" });
  writeFileSync(path.join(api, "dist", "browser-host-main.js"), "export {};\n");
  writeFileSync(path.join(api, "dist", "browser-sessions.js"), "export {};\n");
  writeFileSync(path.join(api, "dist", "config.js"), "export {};\n");
  for (const file of [
    "browser-errors.js",
    "child-process-env.js",
    "cli-runtime-descriptors.js",
    "google-browser-session-check.js",
    "live-model-policy.js",
    "package-version.js",
    "t3-env.js",
    "youtube-ad-block.js"
  ]) {
    writeFileSync(path.join(api, "dist", file), "export {};\n");
  }
  writeFileSync(path.join(web, "server.mjs"), "export {};\n");
  mkdirSync(path.join(db, "migrations"), { recursive: true });
  writeFileSync(path.join(db, "migrations", "0001.sql"), "select 1;\n");
  mkdirSync(path.join(gateway, "grammars"), { recursive: true });
  writeFileSync(path.join(gateway, "grammars", "tree-sitter-typescript.wasm"), "fixture\n");

  mkdirSync(path.join(root, "agent-skills", "example"), { recursive: true });
  writeFileSync(path.join(root, "agent-skills", "example", "SKILL.md"), "skill\n");
  mkdirSync(path.join(root, "starter-memory"), { recursive: true });
  writeFileSync(path.join(root, "starter-memory", "gemini_history.md"), "memory\n");
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  for (const file of [
    "reset-owner-password.mjs",
    "rotate-owner-setup-token.mjs",
    "portable-backup.mjs",
    "portable-restore.mjs"
  ]) {
    writeFileSync(path.join(root, "scripts", file), "export {};\n");
  }
}

test("runtime bundles keep built workspace dependency closures and target assets only", () => {
  const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "spaceapp-runtime-bundles-"));
  const repositoryRoot = path.join(temporaryRoot, "repo");
  const outputRoot = path.join(temporaryRoot, "output");

  try {
    mkdirSync(repositoryRoot, { recursive: true });
    makeRepository(repositoryRoot);
    assert.deepEqual(runtimeWorkspaceSelectors("cli", repositoryRoot), [
      "--workspace=@space/cli-host",
      "--workspace=@space/cli-host-client"
    ]);
    assert.deepEqual(runtimeWorkspaceSelectors("browser", repositoryRoot), [
      "--workspace=@space/browser-host",
      "--workspace=@space/contracts",
      "--workspace=@space/db",
      "--workspace=@space/memory-graph",
      "--workspace=@space/runtime"
    ]);
    assert.throws(() => runtimeWorkspaceSelectors("unknown", repositoryRoot), /Unknown runtime target/);
    const bundles = createRuntimeBundles(repositoryRoot, outputRoot);
    mkdirSync(path.join(repositoryRoot, "apps/api/node_modules/sanitize-html"), { recursive: true });
    writeFileSync(path.join(repositoryRoot, "apps/api/node_modules/sanitize-html/package.json"), "{}\n");
    assert.deepEqual(
      includeWorkspaceNodeModules("core", repositoryRoot, outputRoot),
      [path.join("apps", "api")]
    );

    const core = path.join(outputRoot, "core");
    assert.deepEqual(bundles.core, [
      "@space/api",
      "@space/browser-host",
      "@space/cli-host-client",
      "@space/contracts",
      "@space/db",
      "@space/gateway",
      "@space/icons",
      "@space/web",
      "@space/worker"
    ]);
    assert.ok(readFileSync(path.join(core, "apps/web/server.mjs"), "utf8"));
    assert.ok(readFileSync(path.join(core, "apps/api/dist/browser-host-main.js"), "utf8"));
    assert.ok(readFileSync(path.join(core, "apps/api/node_modules/sanitize-html/package.json"), "utf8"));
    assert.ok(readFileSync(path.join(core, "packages/db/dist/index.js"), "utf8"));
    assert.ok(readFileSync(path.join(core, "packages/icons/package.json"), "utf8"));
    assert.equal(existsSync(path.join(core, "packages/icons/src")), false);
    assert.ok(readFileSync(path.join(core, "packages/db/migrations/0001.sql"), "utf8"));
    assert.ok(readFileSync(path.join(core, "packages/gateway/grammars/tree-sitter-typescript.wasm"), "utf8"));
    assert.ok(readFileSync(path.join(core, "agent-skills/example/SKILL.md"), "utf8"));
    assert.ok(readFileSync(path.join(core, "scripts/portable-backup.mjs"), "utf8"));
    assert.equal(existsSync(path.join(core, "starter-memory")), false);
    assert.equal(existsSync(path.join(core, "apps/api/src/index.ts")), false);
    assert.equal(existsSync(path.join(core, "packages/contracts/tests/index.test.js")), false);
    assert.equal(existsSync(path.join(core, "packages/cli-host")), false);

    const browser = path.join(outputRoot, "browser");
    assert.deepEqual(bundles.browser, [
      "@space/browser-host",
      "@space/contracts",
      "@space/db",
      "@space/memory-graph",
      "@space/runtime"
    ]);
    assert.ok(readFileSync(path.join(browser, "apps/api/dist/browser-host-main.js"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "apps/api/dist/browser-sessions.js"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "apps/api/dist/config.js"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "apps/api/package.json"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "apps/api/dist/browser-errors.js"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "apps/api/dist/google-browser-session-check.js"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "apps/api/dist/package-version.js"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "packages/db/dist/index.js"), "utf8"));
    assert.ok(readFileSync(path.join(browser, "packages/db/migrations/0001.sql"), "utf8"));
    assert.equal(existsSync(path.join(browser, "packages/cli-host")), false);
    assert.equal(existsSync(path.join(browser, "node_modules/node-pty")), false);
    assert.equal(existsSync(path.join(browser, "apps/api/dist/server.js")), false);
    assert.equal(existsSync(path.join(browser, "packages/gateway")), false);
    assert.equal(existsSync(path.join(browser, "apps/worker")), false);
    assert.equal(existsSync(path.join(browser, "apps/web")), false);
    assert.equal(existsSync(path.join(browser, "agent-skills")), false);
    assert.equal(existsSync(path.join(browser, "starter-memory")), false);

    const cli = path.join(outputRoot, "cli");
    assert.deepEqual(bundles.cli, ["@space/cli-host", "@space/cli-host-client"]);
    assert.ok(readFileSync(path.join(cli, "packages/cli-host/dist/index.js"), "utf8"));
    assert.ok(readFileSync(path.join(cli, "packages/cli-host-client/dist/index.js"), "utf8"));
    assert.ok(readFileSync(path.join(cli, "agent-skills/example/SKILL.md"), "utf8"));
    assert.equal(existsSync(path.join(cli, "apps/api")), false);
    assert.equal(existsSync(path.join(cli, "packages/db")), false);
    assert.equal(existsSync(path.join(cli, "starter-memory")), false);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("the core runtime depends on the CLI client protocol but not the PTY host", () => {
  const api = JSON.parse(readFileSync(path.join(repositoryRoot, "apps/api/package.json"), "utf8"));
  const client = JSON.parse(readFileSync(path.join(repositoryRoot, "packages/cli-host-client/package.json"), "utf8"));
  const cliHost = JSON.parse(readFileSync(path.join(repositoryRoot, "packages/cli-host/package.json"), "utf8"));
  const coreSelectors = runtimeWorkspaceSelectors("core", repositoryRoot);

  assert.equal(api.dependencies["@space/cli-host-client"], "0.2.5");
  assert.equal(api.dependencies["@space/cli-host"], undefined);
  assert.equal(api.dependencies["node-pty"], undefined);
  assert.equal(client.dependencies?.["node-pty"], undefined);
  assert.equal(cliHost.dependencies["node-pty"], "^1.1.0");
  assert.ok(coreSelectors.includes("--workspace=@space/cli-host-client"));
  assert.equal(coreSelectors.includes("--workspace=@space/cli-host"), false);
});
