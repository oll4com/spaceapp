#!/usr/bin/env node
// Removes native binaries from node_modules that target a foreign operating
// system or CPU architecture. Container images are built per TARGETARCH, and
// several production packages ship every platform's binary in one tarball
// (node-pty prebuilds, @temporalio/core-bridge releases, @swc/core and
// @napi-rs/canvas optional platform packages, @esbuild binaries). Keeping only
// the image's own platform is safe: the process only ever loads the binary for
// the OS/arch it runs on.
import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const archAliases = Object.freeze({
  amd64: { node: "x64", temporal: "x86_64" },
  arm64: { node: "arm64", temporal: "aarch64" }
});

function existingDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function removeEntries({ directory, keep, kind }) {
  if (!existingDirectory(directory)) {
    return [];
  }
  const removed = [];
  for (const entry of readdirSync(directory)) {
    if (keep.includes(entry)) {
      continue;
    }
    const fullPath = join(directory, entry);
    rmSync(fullPath, { recursive: true, force: true });
    removed.push({ kind, path: fullPath });
  }
  return removed;
}

function removeMatchingPackages({ nodeModulesDir, scope, platformPattern, keepPackageNames, kind }) {
  const scopeDir = join(nodeModulesDir, scope);
  if (!existingDirectory(scopeDir)) {
    return [];
  }
  const removed = [];
  for (const entry of readdirSync(scopeDir)) {
    if (keepPackageNames.includes(entry)) {
      continue;
    }
    if (!platformPattern.test(entry)) {
      continue;
    }
    const fullPath = join(scopeDir, entry);
    rmSync(fullPath, { recursive: true, force: true });
    removed.push({ kind, path: fullPath });
  }
  return removed;
}

export function pruneForeignPlatformBinaries({ nodeModulesDir, arch }) {
  const aliases = archAliases[arch];
  if (!aliases) {
    throw new Error(
      `Unknown arch: ${arch}. Expected one of ${Object.keys(archAliases).join(", ")}.`
    );
  }
  if (!existingDirectory(nodeModulesDir)) {
    throw new Error(`node_modules directory not found: ${nodeModulesDir}`);
  }

  const removed = [];

  removed.push(
    ...removeEntries({
      directory: join(nodeModulesDir, "node-pty", "prebuilds"),
      keep: [`linux-${aliases.node}`],
      kind: "node-pty prebuild"
    })
  );

  removed.push(
    ...removeEntries({
      directory: join(nodeModulesDir, "@temporalio", "core-bridge", "releases"),
      keep: [`${aliases.temporal}-unknown-linux-gnu`],
      kind: "@temporalio core-bridge release"
    })
  );

  removed.push(
    ...removeMatchingPackages({
      nodeModulesDir,
      scope: "@swc",
      platformPattern: /^core-(linux|darwin|win32|freebsd)-/,
      keepPackageNames: [`core-linux-${aliases.node}-gnu`],
      kind: "@swc platform package"
    })
  );

  removed.push(
    ...removeMatchingPackages({
      nodeModulesDir,
      scope: "@napi-rs",
      platformPattern: /^canvas-(linux|darwin|win32|freebsd)-/,
      keepPackageNames: [`canvas-linux-${aliases.node}-gnu`],
      kind: "@napi-rs platform package"
    })
  );

  removed.push(
    ...removeEntries({
      directory: join(nodeModulesDir, "@esbuild"),
      keep: [`linux-${aliases.node}`],
      kind: "@esbuild platform package"
    })
  );

  return { arch, removed };
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function runPruneContainerNativeBinaries(args = process.argv.slice(2)) {
  const arch = optionValue(args, "--arch") ?? process.env.TARGETARCH;
  const nodeModulesDir = optionValue(args, "--node-modules") ?? "node_modules";
  const result = pruneForeignPlatformBinaries({ nodeModulesDir, arch });
  process.stdout.write(
    `prune-container-native-binaries: removed ${result.removed.length} foreign entries for ${arch}\n`
  );
  for (const { kind, path } of result.removed) {
    process.stdout.write(`  - ${kind}: ${path}\n`);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runPruneContainerNativeBinaries();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
