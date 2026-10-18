#!/usr/bin/env node
// Removes files a production container target cannot load at runtime: source
// maps, the TypeScript package npm installs as an auto-installed peer
// dependency (nothing in a production image imports it), native prebuilds for
// platforms the image never runs on, and the Rust sources of the Temporal core
// bridge (the JavaScript loads only releases/<target>/index.node).
//
// Usage: container-image-trim.mjs --target <core|browser|cli> --arch <amd64|arm64>
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const mebibyte = 1024 * 1024;

export const temporalCoreBridgeReleaseTargetByArch = Object.freeze({
  amd64: "x86_64-unknown-linux-gnu",
  arm64: "aarch64-unknown-linux-gnu"
});

export const napiRsCanvasDirectoryByArch = Object.freeze({
  amd64: "canvas-linux-x64-gnu",
  arm64: "canvas-linux-arm64-gnu"
});

const validTargets = new Set(["core", "browser", "cli"]);
const validArchs = new Set(["amd64", "arm64"]);

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function pathSizeBytes(path) {
  const stats = statSync(path);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    total += pathSizeBytes(join(path, entry.name));
  }
  return total;
}

function listFilesRecursive(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true, recursive: true })) {
    if (entry.isFile()) files.push(join(entry.parentPath, entry.name));
  }
  return files;
}

function removePath(path, removed, label) {
  if (!existsSync(path)) return;
  const bytes = pathSizeBytes(path);
  rmSync(path, { recursive: true, force: true });
  removed.push({ label, path, bytes });
}

/**
 * Trims the production node_modules tree of the given container target in the
 * given root directory. The trim is safe for the target only when the
 * node_modules tree was installed for the same architecture.
 */
export function trimContainerNodeModules({ target, arch, root = process.cwd() }) {
  if (!validTargets.has(target)) {
    throw new Error(`Unknown container target: ${target}`);
  }
  if (!validArchs.has(arch)) {
    throw new Error(`Unknown container architecture: ${arch}`);
  }
  const removed = [];
  const nodeModules = join(root, "node_modules");

  // 1. Source maps: nothing imports them at runtime.
  let sourceMapBytes = 0;
  let sourceMapCount = 0;
  if (existsSync(nodeModules)) {
    for (const file of listFilesRecursive(nodeModules)) {
      if (!file.endsWith(".map")) continue;
      const bytes = statSync(file).size;
      rmSync(file, { force: true });
      sourceMapBytes += bytes;
      sourceMapCount += 1;
    }
  }

  // 2. TypeScript: npm installs it as an auto-installed peer dependency
  //    (peer of @t3-oss/env-core). No compiled entry point imports it: the
  //    build compiles TypeScript to JavaScript in the build stage.
  removePath(join(nodeModules, "typescript"), removed, "typescript auto-installed peer");

  // 3. Temporal core bridge: keep only the prebuilt library for this image's
  //    architecture and drop the Rust sources the JavaScript never reads.
  const bridgeReleases = join(nodeModules, "@temporalio", "core-bridge", "releases");
  const bridgeKeep = temporalCoreBridgeReleaseTargetByArch[arch];
  if (existsSync(bridgeReleases)) {
    for (const entry of readdirSync(bridgeReleases, { withFileTypes: true })) {
      if (entry.name !== bridgeKeep) {
        removePath(join(bridgeReleases, entry.name), removed, "temporal core-bridge platform prebuild");
      }
    }
  }
  removePath(join(nodeModules, "@temporalio", "core-bridge", "sdk-core"), removed, "temporal core-bridge Rust sources");

  // 4. node-pty ships Windows and macOS prebuilds; on Linux the install
  //    script builds the PTY from source (scripts/prebuild.js has no Linux
  //    prebuilds), and third_party/conpty is Windows-only console tooling.
  removePath(join(nodeModules, "node-pty", "prebuilds"), removed, "node-pty non-Linux prebuilds");
  removePath(join(nodeModules, "node-pty", "third_party"), removed, "node-pty Windows console tooling");

  // 5. @napi-rs/canvas is installed for every libc of the architecture; the
  //    images are glibc, so the musl builds are dead weight.
  const napiRsRoot = join(nodeModules, "@napi-rs");
  const canvasKeep = napiRsCanvasDirectoryByArch[arch];
  if (existsSync(napiRsRoot)) {
    for (const entry of readdirSync(napiRsRoot, { withFileTypes: true })) {
      if (entry.name.startsWith("canvas-") && entry.name !== canvasKeep) {
        removePath(join(napiRsRoot, entry.name), removed, "@napi-rs/canvas libc or architecture variant");
      }
    }
  }

  return {
    target,
    arch,
    sourceMapCount,
    sourceMapBytes,
    removedBytes: removed.reduce((total, item) => total + item.bytes, 0),
    removed
  };
}

function main() {
  const target = optionValue(process.argv.slice(2), "--target");
  const arch = optionValue(process.argv.slice(2), "--arch");
  if (target === undefined || arch === undefined) {
    process.stderr.write("Usage: container-image-trim.mjs --target <core|browser|cli> --arch <amd64|arm64>\n");
    process.exitCode = 1;
    return;
  }
  const summary = trimContainerNodeModules({ target, arch });
  const reclaimedMiB = (summary.removedBytes + summary.sourceMapBytes) / mebibyte;
  process.stdout.write(
    `container-image-trim: target ${summary.target} arch ${summary.arch}; ` +
    `removed ${summary.removed.length + summary.sourceMapCount} items ` +
    `(${summary.sourceMapCount} source maps), reclaimed ${reclaimedMiB.toFixed(1)} MiB\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
