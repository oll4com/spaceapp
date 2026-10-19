#!/usr/bin/env node
// Removes files a production container target cannot load at runtime: source
// maps across node_modules and workspace build outputs, the TypeScript package
// npm installs as an auto-installed peer dependency (nothing in a production
// image imports it), native prebuilds for platforms or libcs the image never
// runs on, Rust sources of the Temporal core bridge, workspace source/test
// trees, and workspace symlinks for packages not shipped in that target.
//
// Usage: node deploy/docker/container-image-trim.mjs --target <core|browser|cli> --arch <amd64|arm64>
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
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

export const targetWorkspaces = Object.freeze({
  core: Object.freeze(
    new Set([
      "api",
      "worker",
      "web",
      "browser-host",
      "cli-host",
      "codex-app-server",
      "contracts",
      "db",
      "gateway",
      "memory-graph",
      "opencode-control",
      "runtime",
      "streaming"
    ])
  ),
  browser: Object.freeze(
    new Set(["api", "browser-host", "contracts", "db", "memory-graph", "runtime"])
  ),
  cli: Object.freeze(new Set(["cli-host"]))
});

export const browserExcludedNodeModules = Object.freeze([
  "@temporalio",
  "@napi-rs",
  "pdfjs-dist",
  "js-tiktoken",
  "node-pty",
  "node-addon-api"
]);

const validTargets = new Set(["core", "browser", "cli"]);
const validArchs = new Set(["amd64", "arm64"]);
const sourceMapPattern = /\.(?:[cm]?js|d\.ts|css)\.map$/;
const testFilePattern = /\.test(?:-d)?\.(?:[cm]?js|ts)$/;
const workspacePrunedDirs = new Set(["src", "__tests__", "tests"]);

/**
 * Reads the value immediately following a named CLI flag in `args`.
 */
function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Computes the total byte size of a file or directory tree, ignoring symlinks.
 */
function pathSizeBytes(targetPath) {
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch {
    return 0;
  }
  if (stats.isSymbolicLink()) return 0;
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  for (const entry of readdirSync(targetPath, { withFileTypes: true })) {
    total += pathSizeBytes(join(targetPath, entry.name));
  }
  return total;
}

/**
 * Removes `targetPath` if present and records its label and reclaimed byte count.
 */
function removePath(targetPath, removed, label) {
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch {
    return;
  }
  const bytes = stats.isSymbolicLink() ? 0 : pathSizeBytes(targetPath);
  rmSync(targetPath, { recursive: true, force: true });
  removed.push({ label, path: targetPath, bytes });
}

/**
 * Recursively deletes source map files under `directory` and updates `counter`.
 */
function removeSourceMaps(directory, counter) {
  let stats;
  try {
    stats = lstatSync(directory);
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      removeSourceMaps(fullPath, counter);
    } else if (entry.isFile() && sourceMapPattern.test(entry.name)) {
      counter.bytes += pathSizeBytes(fullPath);
      counter.count += 1;
      rmSync(fullPath, { force: true });
    }
  }
}

/**
 * Recursively removes TypeScript source and test directories/files outside `dist` and `node_modules`.
 */
function trimWorkspaceTree(directory, removed) {
  let stats;
  try {
    stats = lstatSync(directory);
  } catch {
    return;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) return;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      if (workspacePrunedDirs.has(entry.name)) {
        removePath(fullPath, removed, "workspace source or test directory");
        continue;
      }
      trimWorkspaceTree(fullPath, removed);
    } else if (entry.isFile() && testFilePattern.test(entry.name)) {
      removePath(fullPath, removed, "workspace test file");
    }
  }
}

/**
 * Trims the production node_modules and workspace trees of the given container
 * target in the given root directory.
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

  // 1. Source maps: nothing imports them at runtime in node_modules or dist.
  const sourceMaps = { count: 0, bytes: 0 };
  for (const dirName of ["node_modules", "apps", "packages"]) {
    const candidate = join(root, dirName);
    if (existsSync(candidate)) {
      removeSourceMaps(candidate, sourceMaps);
    }
  }

  // 2. TypeScript: npm auto-installs it as a peer dependency of
  //    @t3-oss/env-core; the compiled dist/*.js files never import it.
  removePath(join(nodeModules, "typescript"), removed, "auto-installed TypeScript peer");

  // 3. Target-specific package exclusions for the Browser Host image:
  //    deps-browser installs apps/api so browser-host-main.js has its closure,
  //    but browser-host-main.js and packages/db/dist/migrate.js never load
  //    Temporal, @napi-rs/canvas, pdfjs-dist, js-tiktoken, or node-pty.
  if (target === "browser") {
    for (const moduleName of browserExcludedNodeModules) {
      removePath(join(nodeModules, moduleName), removed, `browser unused dependency (${moduleName})`);
    }
  }

  // 4. @temporalio/core-bridge ships native binaries for macOS, Windows, and
  //    both Linux architectures, plus its Rust SDK sources.
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

  // 5. node-pty ships Windows and macOS prebuilds; on Linux the install
  //    script builds the PTY from source (scripts/prebuild.js has no Linux
  //    prebuilds), and third_party/conpty is Windows-only console tooling.
  removePath(join(nodeModules, "node-pty", "prebuilds"), removed, "node-pty non-Linux prebuilds");
  removePath(join(nodeModules, "node-pty", "third_party"), removed, "node-pty Windows console tooling");

  // 6. @napi-rs/canvas is installed for every libc of the architecture; the
  //    images are Debian glibc, so the musl builds and foreign archs are unused.
  const napiRsRoot = join(nodeModules, "@napi-rs");
  const canvasKeep = napiRsCanvasDirectoryByArch[arch];
  if (existsSync(napiRsRoot)) {
    for (const entry of readdirSync(napiRsRoot, { withFileTypes: true })) {
      if (entry.name.startsWith("canvas-") && entry.name !== canvasKeep) {
        removePath(join(napiRsRoot, entry.name), removed, "@napi-rs/canvas libc or architecture variant");
      }
    }
  }

  // 7. Workspace symlinks in node_modules/@space/* and node_modules/run-spaceapp
  //    that point to workspaces not copied into this target image.
  const allowedWorkspaces = targetWorkspaces[target];
  const spaceScope = join(nodeModules, "@space");
  if (existsSync(spaceScope)) {
    for (const entry of readdirSync(spaceScope, { withFileTypes: true })) {
      if (!allowedWorkspaces.has(entry.name)) {
        removePath(join(spaceScope, entry.name), removed, `unshipped workspace link (@space/${entry.name})`);
      }
    }
  }
  removePath(join(nodeModules, "run-spaceapp"), removed, "unshipped workspace link (run-spaceapp)");

  // 8. Workspace TypeScript source and test directories outside dist/.
  for (const dirName of ["apps", "packages"]) {
    const candidate = join(root, dirName);
    if (existsSync(candidate)) {
      trimWorkspaceTree(candidate, removed);
    }
  }

  return {
    target,
    arch,
    sourceMapCount: sourceMaps.count,
    sourceMapBytes: sourceMaps.bytes,
    removedBytes: removed.reduce((total, item) => total + item.bytes, 0),
    removed
  };
}

/**
 * CLI entry point for trimming a container target's dependency closure.
 */
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
