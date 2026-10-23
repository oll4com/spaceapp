#!/usr/bin/env node
// prune-image-deps.mjs — build a minimal, entrypoint-scoped runtime tree for one
// container target out of the monorepo's npm workspaces.
//
// The full build stage ships the entire monorepo (all workspaces, one hoisted
// node_modules). Each runtime image only runs a handful of entrypoints, so it
// must not carry every other service's source and dependencies. This script
// walks package-lock.json starting from the workspaces a target needs and
// materialises only that closure under --out:
//
//   node scripts/prune-image-deps.mjs --target <core|browser|cli> --out <dir>
//
// Output layout mirrors the monorepo root so relative node resolution and the
// npm workspace symlinks keep working:
//   package.json
//   apps/<app>/{package.json,dist/}[,server.mjs]
//   packages/<pkg>/{package.json,dist/}[,migrations/]
//   node_modules/<pkg>/           (full package directory, symlinks preserved)
//   node_modules/@space/<pkg> -> ../../<dir>   (workspace links recreated)
//   node_modules/.package-lock.json
//   <target extras>               (owner/backup scripts, legal files, agent-skills)

import { copyFile, cp, lstat, mkdir, readFile, readlink, realpath, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Workspaces each target starts from (lockfile keys, not npm names). The walk
 * follows `dependencies` + `optionalDependencies` from package-lock.json, so a
 * workspace that only appears as another workspace's dependency is still pulled
 * in transitively (e.g. `@space/icons` via `apps/web`).
 */
const TARGET_WORKSPACES = Object.freeze({
  core: [
    "apps/api",
    "apps/worker",
    "apps/web",
    "packages/browser-host",
    "packages/cli-host",
    "packages/codex-app-server",
    "packages/contracts",
    "packages/db",
    "packages/gateway",
    "packages/memory-graph",
    "packages/opencode-control",
    "packages/runtime",
    "packages/streaming"
  ],
  browser: [
    "apps/api",
    "packages/browser-host",
    "packages/contracts",
    "packages/db",
    "packages/runtime"
  ],
  cli: ["packages/cli-host"]
});

/**
 * Non-code directories a workspace reads at runtime. Most workspaces only need
 * their compiled `dist/`; `@space/db` loads its SQL migrations from the package
 * root (`packages/db/migrations`), so that directory must ship alongside dist.
 */
const WORKSPACE_EXTRA_DIRS = Object.freeze({
  "packages/db": ["migrations"]
});

/**
 * Files/directories copied verbatim from the build stage on top of the computed
 * closure. These are runtime assets that are not npm packages (legal notices,
 * the core operator scripts, the CLI's agent skills).
 */
const TARGET_EXTRAS = Object.freeze({
  core: [
    "scripts/reset-owner-password.mjs",
    "scripts/rotate-owner-setup-token.mjs",
    "scripts/portable-backup.mjs",
    "scripts/portable-restore.mjs",
    "LICENSE",
    "NOTICE",
    "THIRD_PARTY_NOTICES.md",
    "THIRD_PARTY_LICENSES"
  ],
  browser: ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES"],
  cli: ["agent-skills", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md", "THIRD_PARTY_LICENSES"]
});

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function fail(message) {
  throw new Error(message);
}

/**
 * Node's NODE_MODULES_PATHS, expressed over lockfile keys. For a package living
 * at `fromDir`, list the node_modules directories node would consult, in
 * resolution order, skipping `node_modules` path segments (so a package hoisted
 * under `node_modules/@scope/pkg` checks its own nested node_modules, then the
 * root node_modules, and never `node_modules/node_modules`).
 */
function nodeModulesPaths(fromDir) {
  const parts = fromDir.split("/").filter(Boolean);
  const dirs = [];
  for (let i = parts.length; i > 0; i -= 1) {
    if (parts[i - 1] === "node_modules") continue;
    dirs.push(`${parts.slice(0, i).join("/")}/node_modules`);
  }
  dirs.push("node_modules");
  return dirs;
}

/**
 * Resolve a dependency name from `fromDir` to a lockfile `packages` key using
 * the same upward search npm/Node perform. Returns null when the package is not
 * installed (platform-specific optional dependencies, for example).
 */
function resolveDependency(packages, fromDir, name) {
  for (const dir of nodeModulesPaths(fromDir)) {
    const key = `${dir}/${name}`;
    if (Object.hasOwn(packages, key)) return key;
  }
  return null;
}

/**
 * Compute the target's package closure. Returns:
 *   nodeModulesKeys — lockfile keys of every `node_modules/*` package (real
 *     directories and `link: true` workspace links, including nested keys).
 *   workspaceDirs — workspace directory keys to materialise (package.json +
 *     dist), both the roots and any workspace links reached transitively.
 */
function computeClosure(packages, target) {
  const nodeModulesKeys = new Set();
  const workspaceDirs = new Set();

  const collectDependencies = (fromKey, entry) => {
    const dependencies = {
      ...(entry.dependencies ?? {}),
      ...(entry.optionalDependencies ?? {}),
      // Required peer deps are installed by npm alongside the package (e.g.
      // graphology-types, required by graphology via peerDependencies). Without
      // this the closure silently drops them and the pruned image breaks.
      ...(entry.peerDependencies ?? {})
    };
    for (const name of Object.keys(dependencies)) {
      const key = resolveDependency(packages, fromKey, name);
      if (key === null) continue;
      addPackage(key);
    }
  };

  const addWorkspace = (key) => {
    if (workspaceDirs.has(key)) return;
    workspaceDirs.add(key);
    const entry = packages[key];
    if (!entry) {
      process.stderr.write(`prune-image-deps: warning: workspace ${key} missing from lockfile\n`);
      return;
    }
    collectDependencies(key, entry);
  };

  const addPackage = (key) => {
    if (nodeModulesKeys.has(key)) return;
    nodeModulesKeys.add(key);
    const entry = packages[key];
    if (!entry) return; // not installed for this platform (optional dep)
    if (entry.link === true) {
      // npm workspace symlink: materialise the workspace it points at.
      if (typeof entry.resolved === "string") addWorkspace(entry.resolved);
      return;
    }
    collectDependencies(key, entry);
  };

  for (const workspace of TARGET_WORKSPACES[target]) {
    addWorkspace(workspace);
  }

  // Peer dependencies are followed in collectDependencies above: npm installs
  // required peers next to the package, so they are part of the runtime
  // closure. Unmet peers simply don't resolve and are skipped.
  return { nodeModulesKeys, workspaceDirs };
}

function assertSafeOut(root, outRoot) {
  if (outRoot === root) {
    fail(`--out ${outRoot} must not be the source root`);
  }
  const outFromRoot = relative(root, outRoot);
  if (outFromRoot !== "" && !outFromRoot.startsWith("..") && !isAbsolute(outFromRoot)) {
    fail(`--out ${outRoot} must be outside the source tree (${root})`);
  }
}

async function assertSafeOutResolved(root, outRoot) {
  // A lexical check can pass while an existing parent of --out is a symlink
  // into the source tree; rm(outRoot, { recursive: true }) would then delete
  // source files. Resolve the longest existing prefix before validating.
  let probe = outRoot;
  for (;;) {
    try {
      await lstat(probe);
      break;
    } catch {
      const parent = dirname(probe);
      if (parent === probe) break;
      probe = parent;
    }
  }
  const realRoot = await realpath(root).catch(() => root);
  const realProbe = await realpath(probe).catch(() => probe);
  const rel = relative(realRoot, realProbe);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    fail(`--out ${outRoot} resolves inside the source tree (${root})`);
  }
}

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function copyTree(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  await cp(src, dest, { recursive: true, verbatimSymlinks: true, force: true });
}

async function copyFileTo(src, dest) {
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
}

/** Recreate an npm workspace symlink with the exact relative target it had. */
async function recreateWorkspaceLink(root, outRoot, key) {
  const srcLink = join(root, ...key.split("/"));
  const destLink = join(outRoot, ...key.split("/"));
  const target = await readlink(srcLink);
  await mkdir(dirname(destLink), { recursive: true });
  await rm(destLink, { force: true });
  await symlink(target, destLink);
}

/** A key is already covered when a proper ancestor node_modules package in the
 * closure is copied as a full directory (its nested node_modules come along). */
function hasCopiedNodeModulesAncestor(key, nodeModulesKeys) {
  let dir = dirname(key);
  while (dir !== "." && dir !== sep) {
    if (nodeModulesKeys.has(dir)) return true;
    dir = dirname(dir);
  }
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const target = optionValue(args, "--target");
  const out = optionValue(args, "--out");
  if (!target || !TARGET_WORKSPACES[target]) {
    fail("Usage: node scripts/prune-image-deps.mjs --target <core|browser|cli> --out <dir>");
  }
  if (!out) {
    fail("Usage: node scripts/prune-image-deps.mjs --target <core|browser|cli> --out <dir>");
  }

  const root = resolve(process.cwd());
  const outRoot = resolve(out);
  assertSafeOut(root, outRoot);
  await assertSafeOutResolved(root, outRoot);

  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const packages = lock.packages ?? {};
  const { nodeModulesKeys, workspaceDirs } = computeClosure(packages, target);

  await rm(outRoot, { recursive: true, force: true });
  await mkdir(outRoot, { recursive: true });

  // Root metadata only; the runtime never resolves the root's own dependencies.
  await copyFileTo(join(root, "package.json"), join(outRoot, "package.json"));

  // Workspaces: package.json + compiled dist (and the handful of extra runtime
  // directories), preserving the monorepo layout for workspace symlinks.
  for (const workspace of [...workspaceDirs].sort()) {
    await copyFileTo(
      join(root, workspace, "package.json"),
      join(outRoot, workspace, "package.json")
    );
    const distSrc = join(root, workspace, "dist");
    if (await pathExists(distSrc)) {
      await copyTree(distSrc, join(outRoot, workspace, "dist"));
    } else {
      process.stderr.write(`prune-image-deps: warning: ${workspace}/dist missing; copying package.json only\n`);
    }
    for (const extra of WORKSPACE_EXTRA_DIRS[workspace] ?? []) {
      const extraSrc = join(root, workspace, extra);
      if (await pathExists(extraSrc)) {
        await copyTree(extraSrc, join(outRoot, workspace, extra));
      } else {
        process.stderr.write(`prune-image-deps: warning: ${workspace}/${extra} missing\n`);
      }
    }
    if (workspace === "apps/web") {
      const serverSrc = join(root, "apps/web/server.mjs");
      if (await pathExists(serverSrc)) {
        await copyFileTo(serverSrc, join(outRoot, "apps/web/server.mjs"));
      } else {
        process.stderr.write(`prune-image-deps: warning: apps/web/server.mjs missing\n`);
      }
    }
  }

  // node_modules closure. Full directories for real packages (natives like
  // @napi-rs/canvas, node-pty and @temporalio/* must not be split); symlinks
  // recreated for workspace links.
  let packageCount = 0;
  for (const key of [...nodeModulesKeys].sort()) {
    if (hasCopiedNodeModulesAncestor(key, nodeModulesKeys)) continue;
    const entry = packages[key];
    if (entry?.link === true) {
      await recreateWorkspaceLink(root, outRoot, key);
    } else {
      const src = join(root, ...key.split("/"));
      if (await pathExists(src)) {
        await copyTree(src, join(outRoot, ...key.split("/")));
        packageCount += 1;
      }
    }
  }

  // npm's hidden lockfile, present after `npm ci`; harmless when absent.
  const hiddenLock = join(root, "node_modules", ".package-lock.json");
  if (await pathExists(hiddenLock)) {
    await copyFileTo(hiddenLock, join(outRoot, "node_modules", ".package-lock.json"));
  }

  for (const extra of TARGET_EXTRAS[target]) {
    const src = join(root, extra);
    const dest = join(outRoot, extra);
    if (await pathExists(src)) {
      if ((await lstat(src)).isDirectory()) {
        await copyTree(src, dest);
      } else {
        await copyFileTo(src, dest);
      }
    } else {
      process.stderr.write(`prune-image-deps: warning: extra ${extra} missing from build stage\n`);
    }
  }

  process.stdout.write(
    `prune-image-deps: ${target} -> ${outRoot} (${workspaceDirs.size} workspaces, ${packageCount} node_modules packages)\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`prune-image-deps: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
