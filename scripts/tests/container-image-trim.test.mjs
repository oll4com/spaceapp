import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  napiRsCanvasDirectoryByArch,
  temporalCoreBridgeReleaseTargetByArch,
  trimContainerNodeModules
} from "../container-image-trim.mjs";

function makeFakeNodeModules() {
  const root = mkdtempSync(join(tmpdir(), "container-image-trim-"));
  const nodeModules = join(root, "node_modules");
  const file = (path, content = "x") => {
    const absolute = join(nodeModules, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  // Source map and its compiled file.
  file("example/lib/index.js", "module.exports = 1;");
  file("example/lib/index.js.map", "{}");
  // Auto-installed TypeScript peer.
  file("typescript/lib/typescript.js");
  // Temporal core bridge with prebuilds for every platform and Rust sources.
  file("@temporalio/core-bridge/index.js");
  for (const release of ["x86_64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-gnu", "aarch64-unknown-linux-gnu"]) {
    file(`@temporalio/core-bridge/releases/${release}/index.node`, "native");
  }
  file("@temporalio/core-bridge/sdk-core/src/lib.rs");
  // node-pty with Windows prebuilds and Linux source build.
  file("node-pty/build/Release/pty.node", "native");
  file("node-pty/prebuilds/win32-x64/pty.node", "native");
  file("node-pty/third_party/conpty/conpty.dll");
  // @napi-rs/canvas glibc and musl variants for both architectures.
  file("@napi-rs/canvas-linux-x64-gnu/index.js");
  file("@napi-rs/canvas-linux-x64-musl/index.js");
  file("@napi-rs/canvas-linux-arm64-gnu/index.js");
  file("@napi-rs/canvas-linux-arm64-musl/index.js");
  return { root, nodeModules };
}

test("trim keeps only the target architecture Temporal prebuild and drops dead weight", () => {
  const { root, nodeModules } = makeFakeNodeModules();
  try {
    const summary = trimContainerNodeModules({ target: "core", arch: "amd64", root });
    assert.equal(summary.target, "core");
    assert.equal(summary.arch, "amd64");

    // Source maps are gone, compiled files stay.
    assert.equal(existsSync(join(nodeModules, "example/lib/index.js.map")), false);
    assert.equal(existsSync(join(nodeModules, "example/lib/index.js")), true);
    assert.equal(summary.sourceMapCount, 1);

    // The TypeScript peer dependency is removed.
    assert.equal(existsSync(join(nodeModules, "typescript")), false);

    // Only the amd64 Linux Temporal prebuild stays; the Rust sources are gone.
    const releases = join(nodeModules, "@temporalio/core-bridge/releases");
    assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.amd64, "index.node")), true);
    assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.arm64)), false);
    assert.equal(existsSync(join(releases, "x86_64-pc-windows-msvc")), false);
    assert.equal(existsSync(join(nodeModules, "@temporalio/core-bridge/sdk-core")), false);
    assert.equal(existsSync(join(nodeModules, "@temporalio/core-bridge/index.js")), true);

    // node-pty keeps its Linux build, drops Windows tooling and prebuilds.
    assert.equal(existsSync(join(nodeModules, "node-pty/build/Release/pty.node")), true);
    assert.equal(existsSync(join(nodeModules, "node-pty/prebuilds")), false);
    assert.equal(existsSync(join(nodeModules, "node-pty/third_party")), false);

    // Only the glibc canvas variant of the architecture stays.
    assert.equal(existsSync(join(nodeModules, `@napi-rs/${napiRsCanvasDirectoryByArch.amd64}`)), true);
    assert.equal(existsSync(join(nodeModules, "@napi-rs/canvas-linux-x64-musl")), false);
    assert.equal(existsSync(join(nodeModules, "@napi-rs/canvas-linux-arm64-gnu")), false);
    assert.equal(existsSync(join(nodeModules, "@napi-rs/canvas-linux-arm64-musl")), false);

    // Every removed entry is reported with its size.
    assert.ok(summary.removed.every((item) => Number.isSafeInteger(item.bytes) && item.bytes >= 0));
  } finally {
    // mkdtempSync cleanup is not needed; the OS removes its tmpdir.
  }
});

test("trim keeps the arm64 Temporal prebuild and canvas variant for arm64 images", () => {
  const { root, nodeModules } = makeFakeNodeModules();
  trimContainerNodeModules({ target: "browser", arch: "arm64", root });
  const releases = join(nodeModules, "@temporalio/core-bridge/releases");
  assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.arm64, "index.node")), true);
  assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.amd64)), false);
  assert.equal(existsSync(join(nodeModules, `@napi-rs/${napiRsCanvasDirectoryByArch.arm64}`)), true);
  assert.equal(existsSync(join(nodeModules, "@napi-rs/canvas-linux-x64-gnu")), false);
});

test("trim rejects unknown targets and architectures", () => {
  const { root } = makeFakeNodeModules();
  assert.throws(() => trimContainerNodeModules({ target: "sidecar", arch: "amd64", root }), /Unknown container target/);
  assert.throws(() => trimContainerNodeModules({ target: "core", arch: "riscv64", root }), /Unknown container architecture/);
});
