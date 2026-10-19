import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  browserExcludedNodeModules,
  napiRsCanvasDirectoryByArch,
  temporalCoreBridgeReleaseTargetByArch,
  trimContainerNodeModules
} from "../../deploy/docker/container-image-trim.mjs";
import {
  containerImageSizeBudgets,
  evaluateContainerImageSize
} from "../container-image-size-budget.mjs";

const mebibyte = 1024 * 1024;

test("public container size budgets preserve the lightweight release ceilings", () => {
  assert.deepEqual(containerImageSizeBudgets, {
    core: 850 * mebibyte,
    browser: 1350 * mebibyte,
    cli: 1000 * mebibyte
  });
});

test("container size budget accepts an image exactly at its target ceiling", () => {
  assert.deepEqual(
    evaluateContainerImageSize({
      target: "cli",
      sizeBytes: containerImageSizeBudgets.cli
    }),
    {
      target: "cli",
      sizeBytes: containerImageSizeBudgets.cli,
      budgetBytes: containerImageSizeBudgets.cli,
      remainingBytes: 0,
      ok: true
    }
  );
});

test("container size budget blocks an image one byte over its target ceiling", () => {
  const sizeBytes = containerImageSizeBudgets.core + 1;

  assert.deepEqual(evaluateContainerImageSize({ target: "core", sizeBytes }), {
    target: "core",
    sizeBytes,
    budgetBytes: containerImageSizeBudgets.core,
    remainingBytes: -1,
    ok: false
  });
});

test("container size budget rejects unknown targets", () => {
  assert.throws(
    () => evaluateContainerImageSize({ target: "unknown", sizeBytes: 1 }),
    /Unknown container target/
  );
});

/**
 * Creates a temporary workspace and `node_modules` fixture for testing `trimContainerNodeModules`.
 */
function makeFakeWorkspaceTree() {
  const root = mkdtempSync(join(tmpdir(), "container-image-trim-"));
  const file = (relPath, content = "x") => {
    const absolute = join(root, relPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  };
  // Source maps and compiled files in node_modules and workspace dist.
  file("node_modules/example/lib/index.js", "module.exports = 1;");
  file("node_modules/example/lib/index.js.map", "{}");
  file("apps/api/dist/server.js", "export {};");
  file("apps/api/dist/server.js.map", "{}");
  file("apps/api/dist/server.d.ts.map", "{}");
  file("apps/api/src/server.ts", "export {};");
  file("apps/api/tests/server.test.ts", "export {};");
  file("packages/db/migrations/0001_init.sql", "SELECT 1;");
  file("packages/db/dist/migrate.js", "export {};");
  file("packages/db/src/migrate.ts", "export {};");
  // Auto-installed TypeScript peer.
  file("node_modules/typescript/lib/typescript.js");
  // Temporal core bridge with prebuilds for every platform and Rust sources.
  file("node_modules/@temporalio/core-bridge/index.js");
  for (const release of [
    "x86_64-apple-darwin",
    "x86_64-pc-windows-msvc",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu"
  ]) {
    file(`node_modules/@temporalio/core-bridge/releases/${release}/index.node`, "native");
  }
  file("node_modules/@temporalio/core-bridge/sdk-core/src/lib.rs");
  // node-pty with Windows prebuilds and Linux source build.
  file("node_modules/node-pty/build/Release/pty.node", "native");
  file("node_modules/node-pty/prebuilds/win32-x64/pty.node", "native");
  file("node_modules/node-pty/third_party/conpty/conpty.dll");
  // @napi-rs/canvas glibc and musl variants for both architectures.
  file("node_modules/@napi-rs/canvas-linux-x64-gnu/index.js");
  file("node_modules/@napi-rs/canvas-linux-x64-musl/index.js");
  file("node_modules/@napi-rs/canvas-linux-arm64-gnu/index.js");
  file("node_modules/@napi-rs/canvas-linux-arm64-musl/index.js");
  // Browser-excluded heavy modules and workspace directories.
  file("node_modules/pdfjs-dist/build/pdf.mjs");
  file("node_modules/js-tiktoken/dist/index.js");
  file("node_modules/@space/api/package.json", "{}");
  file("node_modules/@space/cli-host/package.json", "{}");
  file("node_modules/@space/icons/package.json", "{}");
  file("node_modules/run-spaceapp/package.json", "{}");
  return root;
}

test("trimContainerNodeModules keeps only target architecture prebuilds and strips source maps and tests", () => {
  const root = makeFakeWorkspaceTree();
  try {
    const summary = trimContainerNodeModules({ target: "core", arch: "amd64", root });
    assert.equal(summary.target, "core");
    assert.equal(summary.arch, "amd64");

    // Source maps in both node_modules and workspace dist are removed; compiled files and SQL migrations stay.
    assert.equal(existsSync(join(root, "node_modules/example/lib/index.js.map")), false);
    assert.equal(existsSync(join(root, "node_modules/example/lib/index.js")), true);
    assert.equal(existsSync(join(root, "apps/api/dist/server.js.map")), false);
    assert.equal(existsSync(join(root, "apps/api/dist/server.d.ts.map")), false);
    assert.equal(existsSync(join(root, "apps/api/dist/server.js")), true);
    assert.equal(existsSync(join(root, "apps/api/src")), false);
    assert.equal(existsSync(join(root, "apps/api/tests")), false);
    assert.equal(existsSync(join(root, "packages/db/migrations/0001_init.sql")), true);
    assert.equal(existsSync(join(root, "packages/db/src")), false);
    assert.equal(summary.sourceMapCount, 3);

    // TypeScript peer is removed; unshipped workspace links (@space/icons, run-spaceapp) are removed.
    assert.equal(existsSync(join(root, "node_modules/typescript")), false);
    assert.equal(existsSync(join(root, "node_modules/@space/api")), true);
    assert.equal(existsSync(join(root, "node_modules/@space/icons")), false);
    assert.equal(existsSync(join(root, "node_modules/run-spaceapp")), false);

    // Only the amd64 Linux Temporal prebuild stays; Rust sources are removed.
    const releases = join(root, "node_modules/@temporalio/core-bridge/releases");
    assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.amd64, "index.node")), true);
    assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.arm64)), false);
    assert.equal(existsSync(join(releases, "x86_64-pc-windows-msvc")), false);
    assert.equal(existsSync(join(root, "node_modules/@temporalio/core-bridge/sdk-core")), false);

    // node-pty keeps its Linux build, drops Windows prebuilds and third_party.
    assert.equal(existsSync(join(root, "node_modules/node-pty/build/Release/pty.node")), true);
    assert.equal(existsSync(join(root, "node_modules/node-pty/prebuilds")), false);
    assert.equal(existsSync(join(root, "node_modules/node-pty/third_party")), false);

    // Only the glibc canvas variant of amd64 stays.
    assert.equal(existsSync(join(root, `node_modules/@napi-rs/${napiRsCanvasDirectoryByArch.amd64}`)), true);
    assert.equal(existsSync(join(root, "node_modules/@napi-rs/canvas-linux-x64-musl")), false);
    assert.equal(existsSync(join(root, "node_modules/@napi-rs/canvas-linux-arm64-gnu")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("trimContainerNodeModules prunes browser-unused heavy packages and keeps arm64 prebuilds for arm64", () => {
  const rootCoreArm = makeFakeWorkspaceTree();
  try {
    trimContainerNodeModules({ target: "core", arch: "arm64", root: rootCoreArm });
    const releases = join(rootCoreArm, "node_modules/@temporalio/core-bridge/releases");
    assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.arm64, "index.node")), true);
    assert.equal(existsSync(join(releases, temporalCoreBridgeReleaseTargetByArch.amd64)), false);
    assert.equal(existsSync(join(rootCoreArm, `node_modules/@napi-rs/${napiRsCanvasDirectoryByArch.arm64}`)), true);
    assert.equal(existsSync(join(rootCoreArm, "node_modules/@napi-rs/canvas-linux-x64-gnu")), false);
  } finally {
    rmSync(rootCoreArm, { recursive: true, force: true });
  }

  const rootBrowser = makeFakeWorkspaceTree();
  try {
    trimContainerNodeModules({ target: "browser", arch: "amd64", root: rootBrowser });
    for (const excluded of browserExcludedNodeModules) {
      assert.equal(existsSync(join(rootBrowser, "node_modules", excluded)), false);
    }
    assert.equal(existsSync(join(rootBrowser, "node_modules/@space/api")), true);
    assert.equal(existsSync(join(rootBrowser, "node_modules/@space/cli-host")), false);
  } finally {
    rmSync(rootBrowser, { recursive: true, force: true });
  }
});

test("trimContainerNodeModules rejects unknown targets and architectures", () => {
  const root = makeFakeWorkspaceTree();
  try {
    assert.throws(
      () => trimContainerNodeModules({ target: "sidecar", arch: "amd64", root }),
      /Unknown container target/
    );
    assert.throws(
      () => trimContainerNodeModules({ target: "core", arch: "riscv64", root }),
      /Unknown container architecture/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

