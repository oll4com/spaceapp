import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  buildBrowserClosure,
  buildCliClosure,
  buildCoreClosure,
  parseArgs,
  resolveDependencyClosure
} from "../prune-container-closures.mjs";

test("parseArgs parses targetarch and output-dir options", () => {
  const result = parseArgs(["--targetarch", "arm64", "--output-dir", "custom-closures"]);
  assert.equal(result.targetArch, "arm64");
  assert.ok(result.outputDir.endsWith("custom-closures"));
});

test("resolveDependencyClosure collects transitive dependencies accurately", () => {
  const fixtureDir = join(import.meta.dirname, "fixtures-deps");
  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(join(fixtureDir, "pkg-a"), { recursive: true });
  mkdirSync(join(fixtureDir, "pkg-b"), { recursive: true });
  mkdirSync(join(fixtureDir, "pkg-c"), { recursive: true });

  writeFileSync(
    join(fixtureDir, "pkg-a", "package.json"),
    JSON.stringify({ name: "pkg-a", dependencies: { "pkg-b": "1.0.0" } })
  );
  writeFileSync(
    join(fixtureDir, "pkg-b", "package.json"),
    JSON.stringify({ name: "pkg-b", dependencies: { "pkg-c": "1.0.0" } })
  );
  writeFileSync(
    join(fixtureDir, "pkg-c", "package.json"),
    JSON.stringify({ name: "pkg-c", dependencies: {} })
  );

  const closure = resolveDependencyClosure(fixtureDir, ["pkg-a"]);
  assert.deepEqual([...closure].sort(), ["pkg-a", "pkg-b", "pkg-c"]);

  rmSync(fixtureDir, { recursive: true, force: true });
});

test("buildCliClosure bundles cli-host and node-pty while pruning foreign prebuilds", () => {
  const fixtureRoot = join(import.meta.dirname, "fixtures-cli-root");
  const targetDir = join(import.meta.dirname, "fixtures-cli-target");

  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });

  mkdirSync(join(fixtureRoot, "packages", "cli-host", "dist"), { recursive: true });
  writeFileSync(join(fixtureRoot, "package.json"), "{}");
  writeFileSync(join(fixtureRoot, "packages", "cli-host", "package.json"), "{}");
  writeFileSync(join(fixtureRoot, "packages", "cli-host", "dist", "main.js"), "console.log('cli');");

  const prebuildsDir = join(fixtureRoot, "node_modules", "node-pty", "prebuilds");
  mkdirSync(join(prebuildsDir, "linux-x64"), { recursive: true });
  mkdirSync(join(prebuildsDir, "linux-arm64"), { recursive: true });
  mkdirSync(join(prebuildsDir, "win32-x64"), { recursive: true });

  buildCliClosure(fixtureRoot, targetDir, "amd64");

  assert.ok(existsSync(join(targetDir, "packages", "cli-host", "dist", "main.js")));
  assert.ok(existsSync(join(targetDir, "node_modules", "node-pty", "prebuilds", "linux-x64")));
  assert.ok(!existsSync(join(targetDir, "node_modules", "node-pty", "prebuilds", "linux-arm64")));
  assert.ok(!existsSync(join(targetDir, "node_modules", "node-pty", "prebuilds", "win32-x64")));

  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
});

test("buildCoreClosure removes node-pty and unneeded temporal core-bridge releases", () => {
  const fixtureRoot = join(import.meta.dirname, "fixtures-core-root");
  const targetDir = join(import.meta.dirname, "fixtures-core-target");

  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(fixtureRoot, { recursive: true });

  writeFileSync(join(fixtureRoot, "package.json"), "{}");
  mkdirSync(join(fixtureRoot, "apps", "api", "dist"), { recursive: true });
  writeFileSync(join(fixtureRoot, "apps", "api", "package.json"), "{}");
  writeFileSync(join(fixtureRoot, "apps", "api", "dist", "server.js"), "console.log('api');");

  mkdirSync(join(fixtureRoot, "node_modules", "node-pty"), { recursive: true });
  mkdirSync(join(fixtureRoot, "node_modules", "typescript"), { recursive: true });
  mkdirSync(join(fixtureRoot, "node_modules", "@types"), { recursive: true });

  const releases = join(fixtureRoot, "node_modules", "@temporalio", "core-bridge", "releases");
  mkdirSync(join(releases, "x86_64-unknown-linux-gnu"), { recursive: true });
  mkdirSync(join(releases, "aarch64-unknown-linux-gnu"), { recursive: true });
  mkdirSync(join(releases, "x86_64-pc-windows-msvc"), { recursive: true });

  buildCoreClosure(fixtureRoot, targetDir, "amd64");

  assert.ok(!existsSync(join(targetDir, "node_modules", "node-pty")));
  assert.ok(!existsSync(join(targetDir, "node_modules", "typescript")));
  assert.ok(!existsSync(join(targetDir, "node_modules", "@types")));
  assert.ok(existsSync(join(targetDir, "node_modules", "@temporalio", "core-bridge", "releases", "x86_64-unknown-linux-gnu")));
  assert.ok(!existsSync(join(targetDir, "node_modules", "@temporalio", "core-bridge", "releases", "aarch64-unknown-linux-gnu")));
  assert.ok(!existsSync(join(targetDir, "node_modules", "@temporalio", "core-bridge", "releases", "x86_64-pc-windows-msvc")));

  rmSync(fixtureRoot, { recursive: true, force: true });
  rmSync(targetDir, { recursive: true, force: true });
});
