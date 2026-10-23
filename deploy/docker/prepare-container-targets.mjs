#!/usr/bin/env node
import { cp, lstat, mkdir, readdir, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultRootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const supportedArchs = new Set(["amd64", "arm64"]);

export const coreWorkspacePackages = Object.freeze([
  "packages/browser-host",
  "packages/cli-host",
  "packages/codex-app-server",
  "packages/contracts",
  "packages/db",
  "packages/gateway",
  "packages/memory-graph",
  "packages/opencode-control",
  "packages/runtime",
  "packages/streaming",
  "apps/api",
  "apps/worker"
]);

export const browserWorkspacePackages = Object.freeze([
  "packages/browser-host",
  "packages/contracts",
  "packages/db",
  "packages/runtime",
  "packages/memory-graph"
]);

export const cliWorkspacePackages = Object.freeze([
  "packages/cli-host"
]);

export const coreOperatorScripts = Object.freeze([
  "scripts/reset-owner-password.mjs",
  "scripts/rotate-owner-setup-token.mjs",
  "scripts/portable-backup.mjs",
  "scripts/portable-restore.mjs"
]);

export function parseTargetArch(argv = process.argv.slice(2), env = process.env) {
  let rawArch = null;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--target-arch") {
      rawArch = argv[index + 1] ?? "";
      index += 1;
    } else if (token.startsWith("--target-arch=")) {
      rawArch = token.slice("--target-arch=".length);
    }
  }
  if (rawArch === null) {
    if (env.TARGETARCH) {
      rawArch = env.TARGETARCH;
    } else if (process.arch === "x64") {
      rawArch = "amd64";
    } else if (process.arch === "arm64") {
      rawArch = "arm64";
    } else {
      rawArch = process.arch;
    }
  }
  const normalized = String(rawArch).trim().toLowerCase();
  if (!supportedArchs.has(normalized)) {
    throw new Error(`Unsupported target architecture: ${rawArch || "<empty>"}. Expected amd64 or arm64.`);
  }
  return normalized;
}

async function pathExists(targetPath) {
  try {
    await lstat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function resolveInstalledPackageDir(rootDir, fromDir, depName) {
  let current = resolve(fromDir);
  const rootResolved = resolve(rootDir);
  while (true) {
    const candidate = join(current, "node_modules", ...depName.split("/"));
    const pkgJson = join(candidate, "package.json");
    if (await pathExists(pkgJson)) {
      const stat = await lstat(candidate);
      if (!stat.isSymbolicLink()) {
        return candidate;
      }
    }
    if (current === rootResolved) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function topLevelNodeModuleRelPath(rootDir, pkgDir) {
  const rel = relative(rootDir, pkgDir).replace(/\\/g, "/");
  const parts = rel.split("/");
  const nmIdx = parts.indexOf("node_modules");
  if (nmIdx === -1) return null;
  const scopeOrName = parts[nmIdx + 1];
  if (!scopeOrName) return null;
  const count = scopeOrName.startsWith("@") ? nmIdx + 3 : nmIdx + 2;
  return parts.slice(0, count).join("/");
}

export async function collectInstalledDependencyClosure({
  rootDir = defaultRootDir,
  workspaceDirs = [],
  seedPackages = [],
  excludedDeps = new Set()
}) {
  const visitedDirs = new Set();
  const topLevelPaths = new Set();
  const queue = [];

  for (const wsRel of workspaceDirs) {
    const wsDir = resolve(rootDir, wsRel);
    if (!visitedDirs.has(wsDir)) {
      visitedDirs.add(wsDir);
      queue.push(wsDir);
    }
  }

  for (const seed of seedPackages) {
    const { fromDir = rootDir, name } = typeof seed === "string" ? { fromDir: rootDir, name: seed } : seed;
    if (excludedDeps.has(name) || name.startsWith("@space/")) continue;
    const resolved = await resolveInstalledPackageDir(rootDir, resolve(rootDir, fromDir), name);
    if (resolved) {
      const topRel = topLevelNodeModuleRelPath(rootDir, resolved);
      if (topRel) topLevelPaths.add(topRel);
      if (!visitedDirs.has(resolved)) {
        visitedDirs.add(resolved);
        queue.push(resolved);
      }
    }
  }

  while (queue.length > 0) {
    const curDir = queue.pop();
    const pkgJsonPath = join(curDir, "package.json");
    if (!(await pathExists(pkgJsonPath))) continue;
    const pkg = JSON.parse(await readFile(pkgJsonPath, "utf8"));
    const peerMeta = pkg.peerDependenciesMeta ?? {};
    const requiredPeers = {};
    for (const [peerName, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (!peerMeta[peerName]?.optional) {
        requiredPeers[peerName] = range;
      }
    }
    const deps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
      ...requiredPeers
    };
    for (const depName of Object.keys(deps)) {
      if (depName.startsWith("@space/") || excludedDeps.has(depName)) continue;
      const resolved = await resolveInstalledPackageDir(rootDir, curDir, depName);
      if (resolved) {
        const topRel = topLevelNodeModuleRelPath(rootDir, resolved);
        if (topRel) topLevelPaths.add(topRel);
        if (!visitedDirs.has(resolved)) {
          visitedDirs.add(resolved);
          queue.push(resolved);
        }
      }
    }
  }

  return [...topLevelPaths].sort();
}

function packageNameFromSpecifier(specifier) {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

export async function traceLocalModuleClosure(entryFile) {
  const visitedFiles = new Set();
  const externalPackages = new Set();
  const queue = [resolve(entryFile)];

  while (queue.length > 0) {
    const file = queue.pop();
    if (visitedFiles.has(file) || !(await pathExists(file))) continue;
    visitedFiles.add(file);
    const code = await readFile(file, "utf8");
    const importRegex = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"'\n]+)["']|import\(\s*["']([^"'\n]+)["']\s*\)/g;
    let match;
    while ((match = importRegex.exec(code)) !== null) {
      const specifier = match[1] ?? match[2];
      if (specifier.startsWith(".")) {
        queue.push(resolve(dirname(file), specifier));
      } else if (!specifier.startsWith("node:")) {
        externalPackages.add(packageNameFromSpecifier(specifier));
      }
    }
  }

  return {
    files: [...visitedFiles].sort(),
    externalPackages: [...externalPackages].sort()
  };
}

async function copyFilteredRuntimeDir(sourceDir, destinationDir) {
  if (!(await pathExists(sourceDir))) return;
  await mkdir(dirname(destinationDir), { recursive: true });
  await cp(sourceDir, destinationDir, {
    recursive: true,
    filter: (sourcePath) => {
      const normalized = sourcePath.replace(/\\/g, "/");
      return (
        !normalized.endsWith(".map") &&
        !normalized.endsWith(".d.ts") &&
        !normalized.endsWith(".test.js") &&
        !normalized.includes("/__tests__/") &&
        !normalized.endsWith("/__tests__")
      );
    }
  });
}

async function copyFileWithParents(sourceFile, destinationFile) {
  await mkdir(dirname(destinationFile), { recursive: true });
  await cp(sourceFile, destinationFile);
}

async function stageWorkspacePackage(rootDir, targetDir, workspaceRel, extraDirs = []) {
  const sourceWorkspace = join(rootDir, workspaceRel);
  const destWorkspace = join(targetDir, workspaceRel);
  await copyFileWithParents(join(sourceWorkspace, "package.json"), join(destWorkspace, "package.json"));
  await copyFilteredRuntimeDir(join(sourceWorkspace, "dist"), join(destWorkspace, "dist"));
  for (const extra of extraDirs) {
    await copyFilteredRuntimeDir(join(sourceWorkspace, extra), join(destWorkspace, extra));
  }
  const pkg = JSON.parse(await readFile(join(sourceWorkspace, "package.json"), "utf8"));
  if (typeof pkg.name === "string" && pkg.name.startsWith("@space/")) {
    const shortName = pkg.name.slice("@space/".length);
    const linkDir = join(targetDir, "node_modules", "@space");
    const linkPath = join(linkDir, shortName);
    await mkdir(linkDir, { recursive: true });
    await rm(linkPath, { recursive: true, force: true });
    await symlink(`../../${workspaceRel}`, linkPath, "dir");
  }
}

async function stageNodeModulesClosure(rootDir, targetDir, moduleRelPaths) {
  for (const relPath of moduleRelPaths) {
    const srcPath = join(rootDir, relPath);
    const dstPath = join(targetDir, relPath);
    if (!(await pathExists(srcPath))) continue;
    await mkdir(dirname(dstPath), { recursive: true });
    await cp(srcPath, dstPath, {
      recursive: true,
      filter: (sourcePath) => !sourcePath.endsWith(".map")
    });
  }
}

async function pruneCoreNativeArtifacts(targetDir, targetArch) {
  const coreBridgeDir = join(targetDir, "node_modules", "@temporalio", "core-bridge");
  if (await pathExists(coreBridgeDir)) {
    const releasesDir = join(coreBridgeDir, "releases");
    const expectedRelease = targetArch === "amd64" ? "x86_64-unknown-linux-gnu" : "aarch64-unknown-linux-gnu";
    if (await pathExists(releasesDir)) {
      const entries = await readdir(releasesDir);
      for (const entry of entries) {
        if (entry !== expectedRelease) {
          await rm(join(releasesDir, entry), { recursive: true, force: true });
        }
      }
    }
    for (const sourceOnly of ["sdk-core", "src", "bridge-macros", "ts"]) {
      await rm(join(coreBridgeDir, sourceOnly), { recursive: true, force: true });
    }
  }

  const napiDir = join(targetDir, "node_modules", "@napi-rs");
  if (await pathExists(napiDir)) {
    const nodeArch = targetArch === "amd64" ? "x64" : "arm64";
    const entries = await readdir(napiDir);
    for (const entry of entries) {
      if (entry === "canvas") continue;
      if (entry.startsWith("canvas-") && !entry.startsWith(`canvas-linux-${nodeArch}-`)) {
        await rm(join(napiDir, entry), { recursive: true, force: true });
      }
    }
  }
}

async function pruneCliNativeArtifacts(targetDir, targetArch) {
  const nodePtyDir = join(targetDir, "node_modules", "node-pty");
  if (!(await pathExists(nodePtyDir))) return;
  const prebuildsDir = join(nodePtyDir, "prebuilds");
  const expectedPrebuild = `linux-${targetArch === "amd64" ? "x64" : "arm64"}`;
  if (await pathExists(prebuildsDir)) {
    const entries = await readdir(prebuildsDir);
    for (const entry of entries) {
      if (entry !== expectedPrebuild) {
        await rm(join(prebuildsDir, entry), { recursive: true, force: true });
      }
    }
  }
  for (const sourceOnly of ["third_party", "deps", "src", "typings"]) {
    await rm(join(nodePtyDir, sourceOnly), { recursive: true, force: true });
  }
}

export async function prepareContainerTargets({
  rootDir = defaultRootDir,
  outputDir = join(rootDir, "targets"),
  targetArch = "amd64"
} = {}) {
  const normalizedArch = parseTargetArch(["--target-arch", targetArch]);
  await rm(outputDir, { recursive: true, force: true });

  // 1. Stage core
  const coreTargetDir = join(outputDir, "core");
  await mkdir(coreTargetDir, { recursive: true });
  await copyFileWithParents(join(rootDir, "package.json"), join(coreTargetDir, "package.json"));
  await copyFilteredRuntimeDir(join(rootDir, "agent-skills"), join(coreTargetDir, "agent-skills"));
  for (const scriptRel of coreOperatorScripts) {
    await copyFileWithParents(join(rootDir, scriptRel), join(coreTargetDir, scriptRel));
  }

  for (const wsRel of coreWorkspacePackages) {
    const extraDirs =
      wsRel === "packages/db"
        ? ["migrations"]
        : wsRel === "packages/gateway"
          ? ["grammars"]
          : [];
    await stageWorkspacePackage(rootDir, coreTargetDir, wsRel, extraDirs);
  }

  // Stage apps/web runtime server and static bundle without frontend build node_modules
  await copyFileWithParents(join(rootDir, "apps/web/package.json"), join(coreTargetDir, "apps/web/package.json"));
  await copyFileWithParents(join(rootDir, "apps/web/server.mjs"), join(coreTargetDir, "apps/web/server.mjs"));
  if (await pathExists(join(rootDir, "apps/web/server-routing.mjs"))) {
    await copyFileWithParents(
      join(rootDir, "apps/web/server-routing.mjs"),
      join(coreTargetDir, "apps/web/server-routing.mjs")
    );
  }
  await copyFilteredRuntimeDir(join(rootDir, "apps/web/dist"), join(coreTargetDir, "apps/web/dist"));

  const coreModulePaths = await collectInstalledDependencyClosure({
    rootDir,
    workspaceDirs: coreWorkspacePackages,
    seedPackages: ["@modelcontextprotocol/sdk", "ws"],
    excludedDeps: new Set(["node-pty"])
  });
  await stageNodeModulesClosure(rootDir, coreTargetDir, coreModulePaths);
  await pruneCoreNativeArtifacts(coreTargetDir, normalizedArch);

  // 2. Stage browser
  const browserTargetDir = join(outputDir, "browser");
  await mkdir(browserTargetDir, { recursive: true });
  await copyFileWithParents(join(rootDir, "package.json"), join(browserTargetDir, "package.json"));
  await copyFileWithParents(join(rootDir, "apps/api/package.json"), join(browserTargetDir, "apps/api/package.json"));

  const browserEntry = join(rootDir, "apps/api/dist/browser-host-main.js");
  const tracedBrowser = await traceLocalModuleClosure(browserEntry);
  for (const file of tracedBrowser.files) {
    const rel = relative(rootDir, file);
    await copyFileWithParents(file, join(browserTargetDir, rel));
  }

  for (const wsRel of browserWorkspacePackages) {
    const extraDirs = wsRel === "packages/db" ? ["migrations"] : [];
    await stageWorkspacePackage(rootDir, browserTargetDir, wsRel, extraDirs);
  }

  const browserSeedPackages = tracedBrowser.externalPackages
    .filter((pkgName) => !pkgName.startsWith("@space/"))
    .map((pkgName) => ({ fromDir: "apps/api", name: pkgName }));

  const browserModulePaths = await collectInstalledDependencyClosure({
    rootDir,
    workspaceDirs: browserWorkspacePackages,
    seedPackages: browserSeedPackages,
    excludedDeps: new Set(["node-pty"])
  });
  await stageNodeModulesClosure(rootDir, browserTargetDir, browserModulePaths);

  // 3. Stage cli
  const cliTargetDir = join(outputDir, "cli");
  await mkdir(cliTargetDir, { recursive: true });
  await copyFileWithParents(join(rootDir, "package.json"), join(cliTargetDir, "package.json"));
  await copyFilteredRuntimeDir(join(rootDir, "agent-skills"), join(cliTargetDir, "agent-skills"));

  for (const wsRel of cliWorkspacePackages) {
    await stageWorkspacePackage(rootDir, cliTargetDir, wsRel);
  }

  const cliModulePaths = await collectInstalledDependencyClosure({
    rootDir,
    workspaceDirs: cliWorkspacePackages
  });
  await stageNodeModulesClosure(rootDir, cliTargetDir, cliModulePaths);
  await pruneCliNativeArtifacts(cliTargetDir, normalizedArch);

  return {
    targetArch: normalizedArch,
    coreModuleCount: coreModulePaths.length,
    browserModuleCount: browserModulePaths.length,
    cliModuleCount: cliModulePaths.length
  };
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const targetArch = parseTargetArch();
  await prepareContainerTargets({ targetArch });
}
