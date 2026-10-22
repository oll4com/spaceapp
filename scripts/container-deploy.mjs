#!/usr/bin/env node
import { cp, lstat, mkdir, readdir, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { nodeFileTrace } from "@vercel/nft";

// Trace the actual process entrypoints rather than package.json workspace
// dependencies: the API package also owns the independently deployed browser host.
export const containerTargets = Object.freeze({
  core: {
    entrypoints: [
      "apps/api/dist/server.js",
      "apps/worker/dist/worker.js",
      "apps/worker/dist/memory-maintenance-worker.js",
      "apps/worker/dist/memory-mutation-worker.js",
      "apps/worker/dist/workflows.js",
      "apps/worker/dist/memory-maintenance-workflows.js",
      "apps/worker/dist/memory-mutation-workflows.js",
      // Temporal generates require() calls to these two modules at runtime.
      "node_modules/@temporalio/workflow/lib/worker-interface.js",
      "node_modules/@temporalio/workflow/lib/global-overrides.js",
      "packages/db/dist/migrate.js",
      "apps/web/server.mjs",
      "scripts/reset-owner-password.mjs",
      "scripts/rotate-owner-setup-token.mjs",
      "scripts/portable-backup.mjs",
      "scripts/portable-restore.mjs"
    ],
    assets: ["apps/web/dist", "apps/worker/dist", "apps/api/dist/databases/sqlite-worker.py", "packages/db/migrations", "agent-skills"]
  },
  browser: { entrypoints: ["apps/api/dist/browser-host-main.js"], assets: [] },
  cli: { entrypoints: ["packages/cli-host/dist/main.js"], assets: ["agent-skills"] }
});

const sharedAssets = ["package.json", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES", "deploy/docker"];

function contained(root, value) {
  const path = resolve(root, value);
  const rel = relative(root, path);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Container input is outside the source directory: ${value}`);
  }
  return path;
}

async function filesUnder(root, value) {
  const full = contained(root, value);
  const info = await lstat(full);
  if (!info.isDirectory()) return [value];
  const entries = await readdir(full, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => filesUnder(root, join(value, entry.name))));
  return nested.flat();
}

async function optionalFilesUnder(root, value) {
  try {
    return await filesUnder(root, value);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

// Dynamic native-addon loaders may enumerate every prebuild in a package.
// The deploy directory is made inside the target-platform build, not on the
// cross-compiling host. Keep source-built addons and only its matching prebuild.
export function isTargetNativeFile(file, platform = process.platform, arch = process.arch) {
  const normalized = file.replaceAll("\\", "/");
  const pty = normalized.match(/(?:^|\/)node-pty\/prebuilds\/([^/]+)\//);
  if (pty && pty[1] !== `${platform}-${arch}`) return false;
  const temporal = normalized.match(/@temporalio\/core-bridge\/releases\/([^/]+)\//);
  if (temporal && platform === "linux") {
    const expected = arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    if (temporal[1] !== expected) return false;
  }
  return true;
}

export async function createContainerDeploy({ root = process.cwd(), output, target }) {
  root = await realpath(root);
  const config = containerTargets[target];
  if (!config) throw new Error(`Unknown container target: ${target}`);
  if (!output) throw new Error("An empty, new output directory is required");
  output = resolve(output);
  if (output === root || root.startsWith(`${output}${sep}`)) {
    throw new Error("The output directory must not contain the source directory");
  }
  // Never overwrite or remove an existing directory.
  await mkdir(output, { recursive: false });
  const entries = [...config.entrypoints];
  for (const path of entries) await stat(contained(root, path));
  const trace = await nodeFileTrace(entries.map((entry) => contained(root, entry)), {
    base: root,
    processCwd: root,
    exportsOnly: true,
    // These are copied as assets, never executed by the service. Avoid following
    // examples inside skills or accidental globbing of local Git metadata.
    ignore(file) {
      const path = file.replaceAll("\\", "/");
      return /(^|\/)\.git(\/|$)/.test(path) || path.startsWith("agent-skills/") || path.startsWith("starter-memory/");
    }
  });
  const files = new Set(trace.fileList);
  // node-pty constructs its require path from nested loops, which cannot be
  // resolved by static tracing. Linux npm ci builds pty.node and spawn-helper.
  // Include these runtime artifacts explicitly whenever the loader is reached.
  if (files.has("node_modules/node-pty/package.json")) {
    for (const folder of ["build/Release", `prebuilds/${process.platform}-${process.arch}`]) {
      for (const file of await optionalFilesUnder(root, `node_modules/node-pty/${folder}`)) {
        files.add(file);
      }
    }
    if (process.platform === "linux" && ![...files].some((file) => /node-pty\/.*\/pty\.node$/.test(file))) {
      throw new Error("node-pty native runtime is missing; run npm ci with install scripts enabled");
    }
  }
  for (const asset of [...sharedAssets, ...config.assets]) {
    for (const file of await filesUnder(root, asset)) files.add(file);
  }
  // File traces include package.json files used to resolve imports and workspace
  // links. Preserve their relative paths instead of flattening node_modules.
  const selected = [...files].filter((file) => isTargetNativeFile(file)).sort();
  const links = [];
  let bytes = 0;
  for (const file of selected) {
    const source = contained(root, file);
    const destination = contained(output, file);
    const info = await lstat(source);
    await mkdir(dirname(destination), { recursive: true });
    if (info.isSymbolicLink()) {
      const link = await readlink(source);
      // Absolute or escaping links would point back into the build stage.
      if (isAbsolute(link)) throw new Error(`Absolute deploy symlink: ${file}`);
      contained(root, relative(root, resolve(dirname(source), link)));
      links.push({ destination, link });
    } else if (info.isFile()) {
      await cp(source, destination, { preserveTimestamps: true });
      bytes += info.size;
    }
  }
  for (const { destination, link } of links) await symlink(link, destination);
  const manifest = {
    target,
    platform: process.platform,
    arch: process.arch,
    entrypoints: entries,
    fileCount: selected.length,
    bytes,
    files: selected.map((file) => file.replaceAll("\\", "/")),
    warnings: [...trace.warnings].map((warning) => warning.message).sort()
  };
  await writeFile(join(output, "container-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [target, output] = process.argv.slice(2);
  try {
    const result = await createContainerDeploy({ target, output });
    process.stdout.write(`${JSON.stringify({ target, files: result.fileCount, bytes: result.bytes, warnings: result.warnings })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
