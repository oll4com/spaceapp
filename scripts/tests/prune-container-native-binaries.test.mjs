import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pruneForeignPlatformBinaries } from "../prune-container-native-binaries.mjs";

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "prune-native-"));
  const nodeModules = join(root, "node_modules");
  const dirs = [
    ["node-pty", "prebuilds", "linux-x64"],
    ["node-pty", "prebuilds", "linux-arm64"],
    ["node-pty", "prebuilds", "darwin-x64"],
    ["node-pty", "prebuilds", "darwin-arm64"],
    ["node-pty", "prebuilds", "win32-x64"],
    ["node-pty", "prebuilds", "win32-arm64"],
    ["@temporalio", "core-bridge", "releases", "x86_64-unknown-linux-gnu"],
    ["@temporalio", "core-bridge", "releases", "aarch64-unknown-linux-gnu"],
    ["@temporalio", "core-bridge", "releases", "aarch64-apple-darwin"],
    ["@temporalio", "core-bridge", "releases", "x86_64-apple-darwin"],
    ["@temporalio", "core-bridge", "releases", "x86_64-pc-windows-msvc"],
    ["@swc", "core"],
    ["@swc", "types"],
    ["@swc", "core-linux-x64-gnu"],
    ["@swc", "core-linux-x64-musl"],
    ["@swc", "core-linux-arm64-gnu"],
    ["@swc", "core-linux-arm64-musl"],
    ["@swc", "core-darwin-arm64"],
    ["@napi-rs", "canvas"],
    ["@napi-rs", "canvas-linux-x64-gnu"],
    ["@napi-rs", "canvas-linux-x64-musl"],
    ["@napi-rs", "canvas-linux-arm64-gnu"],
    ["@napi-rs", "canvas-darwin-arm64"],
    ["@esbuild", "linux-x64"],
    ["@esbuild", "linux-arm64"],
    ["@esbuild", "darwin-arm64"]
  ];
  for (const segments of dirs) {
    const fullPath = join(nodeModules, ...segments);
    mkdirSync(fullPath, { recursive: true });
    writeFileSync(join(fullPath, "marker"), segments.join("/"));
  }
  return { root, nodeModules };
}

test("prune keeps only the amd64 platform binaries and never touches arch-neutral packages", () => {
  const { root, nodeModules } = makeFixture();
  try {
    const { removed } = pruneForeignPlatformBinaries({ nodeModulesDir: nodeModules, arch: "amd64" });

    assert.equal(removed.length, 18);
    assert.ok(existsSync(join(nodeModules, "node-pty", "prebuilds", "linux-x64")));
    assert.ok(
      existsSync(join(nodeModules, "@temporalio", "core-bridge", "releases", "x86_64-unknown-linux-gnu"))
    );
    assert.ok(existsSync(join(nodeModules, "@swc", "core-linux-x64-gnu")));
    assert.ok(existsSync(join(nodeModules, "@napi-rs", "canvas-linux-x64-gnu")));
    assert.ok(existsSync(join(nodeModules, "@esbuild", "linux-x64")));
    assert.ok(existsSync(join(nodeModules, "@swc", "core")));
    assert.ok(existsSync(join(nodeModules, "@swc", "types")));
    assert.ok(existsSync(join(nodeModules, "@napi-rs", "canvas")));

    assert.ok(!existsSync(join(nodeModules, "node-pty", "prebuilds", "win32-x64")));
    assert.ok(!existsSync(join(nodeModules, "node-pty", "prebuilds", "darwin-arm64")));
    assert.ok(!existsSync(join(nodeModules, "node-pty", "prebuilds", "linux-arm64")));
    assert.ok(
      !existsSync(join(nodeModules, "@temporalio", "core-bridge", "releases", "aarch64-unknown-linux-gnu"))
    );
    assert.ok(!existsSync(join(nodeModules, "@temporalio", "core-bridge", "releases", "x86_64-pc-windows-msvc")));
    assert.ok(!existsSync(join(nodeModules, "@swc", "core-linux-x64-musl")));
    assert.ok(!existsSync(join(nodeModules, "@swc", "core-linux-arm64-gnu")));
    assert.ok(!existsSync(join(nodeModules, "@napi-rs", "canvas-linux-x64-musl")));
    assert.ok(!existsSync(join(nodeModules, "@esbuild", "darwin-arm64")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune keeps only the arm64 platform binaries", () => {
  const { root, nodeModules } = makeFixture();
  try {
    pruneForeignPlatformBinaries({ nodeModulesDir: nodeModules, arch: "arm64" });

    assert.ok(existsSync(join(nodeModules, "node-pty", "prebuilds", "linux-arm64")));
    assert.ok(
      existsSync(join(nodeModules, "@temporalio", "core-bridge", "releases", "aarch64-unknown-linux-gnu"))
    );
    assert.ok(existsSync(join(nodeModules, "@swc", "core-linux-arm64-gnu")));
    assert.ok(existsSync(join(nodeModules, "@napi-rs", "canvas-linux-arm64-gnu")));
    assert.ok(existsSync(join(nodeModules, "@esbuild", "linux-arm64")));

    assert.ok(!existsSync(join(nodeModules, "node-pty", "prebuilds", "linux-x64")));
    assert.ok(
      !existsSync(join(nodeModules, "@temporalio", "core-bridge", "releases", "x86_64-unknown-linux-gnu"))
    );
    assert.ok(!existsSync(join(nodeModules, "@swc", "core-linux-x64-gnu")));
    assert.ok(!existsSync(join(nodeModules, "@napi-rs", "canvas-linux-x64-gnu")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune skips packages that are absent from the closure", () => {
  const root = mkdtempSync(join(tmpdir(), "prune-native-empty-"));
  try {
    const nodeModules = join(root, "node_modules");
    mkdirSync(join(nodeModules, "node-pty", "prebuilds", "linux-x64"), { recursive: true });

    const { removed } = pruneForeignPlatformBinaries({ nodeModulesDir: nodeModules, arch: "amd64" });

    assert.equal(removed.length, 0);
    assert.ok(existsSync(join(nodeModules, "node-pty", "prebuilds", "linux-x64")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("prune rejects unknown architectures and missing node_modules", () => {
  assert.throws(
    () => pruneForeignPlatformBinaries({ nodeModulesDir: tmpdir(), arch: "riscv64" }),
    /Unknown arch/
  );
  assert.throws(
    () => pruneForeignPlatformBinaries({ nodeModulesDir: "/nonexistent-node-modules", arch: "amd64" }),
    /node_modules directory not found/
  );
});
