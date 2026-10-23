#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const CONTAINER_TARGETS = Object.freeze(["core", "browser", "cli"]);

const CORE_WORKSPACES = Object.freeze([
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
]);

const BROWSER_WORKSPACES = Object.freeze([
  "apps/api",
  "packages/browser-host",
  "packages/contracts",
  "packages/db",
  "packages/memory-graph",
  "packages/runtime"
]);

const CLI_WORKSPACES = Object.freeze(["packages/cli-host"]);

const CORE_SCRIPTS = Object.freeze([
  "scripts/reset-owner-password.mjs",
  "scripts/rotate-owner-setup-token.mjs",
  "scripts/portable-backup.mjs",
  "scripts/portable-restore.mjs"
]);

function normalizeArch(arch = "") {
  const value = String(arch || process.arch).trim().toLowerCase();
  if (value === "amd64" || value === "x64" || value === "x86_64") {
    return "amd64";
  }
  if (value === "arm64" || value === "aarch64") {
    return "arm64";
  }
  return value;
}

export function resolveTemporalBridgeReleaseTarget(arch = "", platform = "linux") {
  const normalizedArch = normalizeArch(arch);
  const rustArch = normalizedArch === "arm64" ? "aarch64" : "x86_64";
  if (platform === "win32") {
    return `${rustArch}-pc-windows-msvc`;
  }
  if (platform === "darwin") {
    return `${rustArch}-apple-darwin`;
  }
  return `${rustArch}-unknown-linux-gnu`;
}

function resolvePackageDir(sourceRoot, fromDir, pkgName) {
  let current = fromDir;
  const normalizedSourceRoot = path.resolve(sourceRoot);
  while (true) {
    const candidate = path.join(current, "node_modules", ...pkgName.split("/"));
    if (existsSync(path.join(candidate, "package.json"))) {
      return realpathSync(candidate);
    }
    if (path.resolve(current) === normalizedSourceRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  const fallback = path.join(normalizedSourceRoot, "node_modules", ...pkgName.split("/"));
  if (existsSync(path.join(fallback, "package.json"))) {
    return realpathSync(fallback);
  }
  return null;
}

export function traceLocalAndExternalImports(entryFiles) {
  const visitedFiles = new Set();
  const externalPackages = new Set();
  const queue = entryFiles.map((file) => path.resolve(file));

  while (queue.length > 0) {
    const currentFile = queue.shift();
    if (!currentFile || visitedFiles.has(currentFile) || !existsSync(currentFile)) {
      continue;
    }
    visitedFiles.add(currentFile);
    const code = readFileSync(currentFile, "utf8");
    const matches = [
      ...code.matchAll(
        /(?:^|\n)\s*(?:import|export)\s+(?!type\s+\{[^}]*\}\s+from\b)(?!type\s+\w+\s+from\b)[\s\S]*?\s+from\s+["']([^"']+)["']/g
      ),
      ...code.matchAll(/(?:^|\n)\s*import\s+["']([^"']+)["']/g),
      ...code.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g),
      ...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)
    ];

    for (const match of matches) {
      const specifier = match[1];
      if (!specifier || specifier.startsWith("node:")) {
        continue;
      }
      if (specifier.startsWith(".")) {
        const base = path.resolve(path.dirname(currentFile), specifier);
        for (const candidate of [
          base,
          `${base}.js`,
          path.join(base, "index.js")
        ]) {
          if (existsSync(candidate) && lstatSync(candidate).isFile()) {
            queue.push(candidate);
            break;
          }
        }
      } else {
        const parts = specifier.split("/");
        const pkgName = specifier.startsWith("@")
          ? parts.slice(0, 2).join("/")
          : parts[0];
        externalPackages.add(pkgName);
      }
    }
  }

  return {
    localFiles: [...visitedFiles].sort(),
    externalPackages: [...externalPackages].sort()
  };
}

export function collectNpmDependencyClosure({
  sourceRoot,
  seeds,
  excludedPackages = new Set()
}) {
  const normalizedRoot = realpathSync(sourceRoot);
  const visitedDirs = new Set();
  const queue = [];

  for (const { fromDir, name } of seeds) {
    if (excludedPackages.has(name) || name.startsWith("@space/")) {
      continue;
    }
    const resolved = resolvePackageDir(normalizedRoot, fromDir, name);
    if (resolved) {
      queue.push(resolved);
    }
  }

  while (queue.length > 0) {
    const pkgDir = queue.shift();
    if (!pkgDir || visitedDirs.has(pkgDir)) {
      continue;
    }
    visitedDirs.add(pkgDir);

    const pkgJsonPath = path.join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) {
      continue;
    }
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
    const deps = {
      ...(pkgJson.dependencies ?? {}),
      ...(pkgJson.optionalDependencies ?? {})
    };
    for (const depName of Object.keys(deps)) {
      if (excludedPackages.has(depName) || depName.startsWith("@space/")) {
        continue;
      }
      const depDir = resolvePackageDir(normalizedRoot, pkgDir, depName);
      if (depDir && !visitedDirs.has(depDir)) {
        queue.push(depDir);
      }
    }
  }

  return [...visitedDirs].sort();
}

function shouldSkipRuntimeFile(filePath) {
  const base = path.basename(filePath);
  if (
    base.endsWith(".d.ts") ||
    base.endsWith(".d.mts") ||
    base.endsWith(".d.cts") ||
    base.endsWith(".js.map") ||
    base.endsWith(".mjs.map") ||
    base.endsWith(".cjs.map") ||
    base.endsWith(".css.map") ||
    base.endsWith(".d.ts.map") ||
    base.endsWith(".tsbuildinfo")
  ) {
    return true;
  }
  return false;
}

function copyDirectoryFiltered(srcDir, destDir, { skipChildNodeModules = false, filter } = {}) {
  if (!existsSync(srcDir)) {
    return;
  }
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (skipChildNodeModules && entry.name === "node_modules") {
      continue;
    }
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (filter && !filter(srcPath, entry)) {
      continue;
    }
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      copyDirectoryFiltered(srcPath, destPath, { skipChildNodeModules: false, filter });
    } else if (entry.isFile()) {
      if (shouldSkipRuntimeFile(srcPath)) {
        continue;
      }
      cpSync(srcPath, destPath);
    }
  }
}

function linkWorkspaceInNodeModules(targetRoot, workspaceRelPath) {
  const pkgJsonPath = path.join(targetRoot, workspaceRelPath, "package.json");
  if (!existsSync(pkgJsonPath)) {
    return;
  }
  const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  if (!pkgJson.name?.startsWith("@space/")) {
    return;
  }
  const linkPath = path.join(targetRoot, "node_modules", ...pkgJson.name.split("/"));
  mkdirSync(path.dirname(linkPath), { recursive: true });
  rmSync(linkPath, { recursive: true, force: true });
  const relativeTarget = path.relative(path.dirname(linkPath), path.join(targetRoot, workspaceRelPath));
  try {
    symlinkSync(relativeTarget, linkPath, "dir");
  } catch {
    cpSync(path.join(targetRoot, workspaceRelPath), linkPath, { recursive: true });
  }
}

function pruneTemporalCoreBridge(targetRoot, arch) {
  const bridgeDir = path.join(targetRoot, "node_modules", "@temporalio", "core-bridge");
  if (!existsSync(bridgeDir)) {
    return;
  }
  for (const unnecessary of ["sdk-core", "src", "bridge-macros", "ts", "scripts"]) {
    rmSync(path.join(bridgeDir, unnecessary), { recursive: true, force: true });
  }
  const releasesDir = path.join(bridgeDir, "releases");
  if (existsSync(releasesDir)) {
    const keepTarget = resolveTemporalBridgeReleaseTarget(arch, "linux");
    for (const entry of readdirSync(releasesDir, { withFileTypes: true })) {
      if (entry.name !== keepTarget) {
        rmSync(path.join(releasesDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function pruneNodePty(targetRoot, arch) {
  const ptyDir = path.join(targetRoot, "node_modules", "node-pty");
  if (!existsSync(ptyDir)) {
    return;
  }
  for (const unnecessary of ["deps", "third_party", "src", "typings", "scripts"]) {
    rmSync(path.join(ptyDir, unnecessary), { recursive: true, force: true });
  }
  rmSync(path.join(ptyDir, "build", "Release", "obj.target"), {
    recursive: true,
    force: true
  });
  const prebuildsDir = path.join(ptyDir, "prebuilds");
  if (existsSync(prebuildsDir)) {
    const normalizedArch = normalizeArch(arch);
    const keepLinux = `linux-${normalizedArch === "arm64" ? "arm64" : "x64"}`;
    for (const entry of readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (entry.name !== keepLinux) {
        rmSync(path.join(prebuildsDir, entry.name), { recursive: true, force: true });
      }
    }
  }
}

function stageWorkspacePackage(sourceRoot, targetRoot, workspaceRelPath, { distFileAllowlist = null } = {}) {
  const srcWs = path.join(sourceRoot, workspaceRelPath);
  const destWs = path.join(targetRoot, workspaceRelPath);
  mkdirSync(destWs, { recursive: true });

  const pkgJsonPath = path.join(srcWs, "package.json");
  if (existsSync(pkgJsonPath)) {
    cpSync(pkgJsonPath, path.join(destWs, "package.json"));
  }

  if (workspaceRelPath === "apps/web") {
    for (const fileName of ["server.mjs", "server-routing.mjs"]) {
      const srcFile = path.join(srcWs, fileName);
      if (existsSync(srcFile)) {
        cpSync(srcFile, path.join(destWs, fileName));
      }
    }
    copyDirectoryFiltered(path.join(srcWs, "dist"), path.join(destWs, "dist"));
    return;
  }

  const distSrc = path.join(srcWs, "dist");
  const distDest = path.join(destWs, "dist");
  if (existsSync(distSrc)) {
    copyDirectoryFiltered(distSrc, distDest, {
      filter: (srcPath, entry) => {
        if (entry.isDirectory()) {
          return true;
        }
        if (distFileAllowlist) {
          return distFileAllowlist.has(path.resolve(srcPath));
        }
        if (workspaceRelPath === "apps/api" && path.basename(srcPath) === "browser-host-main.js") {
          return false;
        }
        return true;
      }
    });
  }

  if (workspaceRelPath === "packages/db") {
    copyDirectoryFiltered(path.join(srcWs, "migrations"), path.join(destWs, "migrations"));
  }
  if (workspaceRelPath === "packages/gateway") {
    copyDirectoryFiltered(path.join(srcWs, "grammars"), path.join(destWs, "grammars"));
  }

  linkWorkspaceInNodeModules(targetRoot, workspaceRelPath);
}

function stageTargetNpmPackages(sourceRoot, targetRoot, packageDirs) {
  const normalizedSourceRoot = realpathSync(sourceRoot);
  for (const pkgDir of packageDirs) {
    const relPath = path.relative(normalizedSourceRoot, pkgDir);
    if (!relPath || relPath.startsWith("..")) {
      continue;
    }
    const destDir = path.join(targetRoot, relPath);
    copyDirectoryFiltered(pkgDir, destDir, { skipChildNodeModules: true });
  }
}

function writeRootPackageManifest(sourceRoot, targetRoot, { copyLockfile = false } = {}) {
  const rootPkgPath = path.join(sourceRoot, "package.json");
  if (existsSync(rootPkgPath)) {
    const pkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
    writeFileSync(
      path.join(targetRoot, "package.json"),
      `${JSON.stringify(
        {
          name: pkg.name,
          version: pkg.version,
          private: true,
          license: pkg.license,
          type: pkg.type,
          workspaces: pkg.workspaces,
          engines: pkg.engines
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }
  if (copyLockfile) {
    const lockPath = path.join(sourceRoot, "package-lock.json");
    if (existsSync(lockPath)) {
      cpSync(lockPath, path.join(targetRoot, "package-lock.json"));
    }
  }
}

export function stageCoreTarget({ sourceRoot, outputDir, arch }) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  writeRootPackageManifest(sourceRoot, outputDir, { copyLockfile: true });

  for (const ws of CORE_WORKSPACES) {
    stageWorkspacePackage(sourceRoot, outputDir, ws);
  }

  copyDirectoryFiltered(
    path.join(sourceRoot, "agent-skills"),
    path.join(outputDir, "agent-skills")
  );

  for (const scriptRel of CORE_SCRIPTS) {
    const srcScript = path.join(sourceRoot, scriptRel);
    if (existsSync(srcScript)) {
      const destScript = path.join(outputDir, scriptRel);
      mkdirSync(path.dirname(destScript), { recursive: true });
      cpSync(srcScript, destScript);
    }
  }

  const seeds = [
    { fromDir: sourceRoot, name: "@modelcontextprotocol/sdk" },
    { fromDir: sourceRoot, name: "ws" }
  ];
  for (const ws of CORE_WORKSPACES) {
    if (ws === "apps/web") {
      continue;
    }
    const wsDir = path.join(sourceRoot, ws);
    const pkgJson = JSON.parse(readFileSync(path.join(wsDir, "package.json"), "utf8"));
    for (const depName of Object.keys(pkgJson.dependencies ?? {})) {
      seeds.push({ fromDir: wsDir, name: depName });
    }
  }

  const npmClosure = collectNpmDependencyClosure({
    sourceRoot,
    seeds,
    excludedPackages: new Set(["node-pty", "typescript"])
  });
  stageTargetNpmPackages(sourceRoot, outputDir, npmClosure);
  pruneTemporalCoreBridge(outputDir, arch);

  return {
    target: "core",
    outputDir,
    workspaces: CORE_WORKSPACES,
    npmPackageCount: npmClosure.length
  };
}

export function stageBrowserTarget({ sourceRoot, outputDir }) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  writeRootPackageManifest(sourceRoot, outputDir, { copyLockfile: false });

  const browserEntry = path.join(sourceRoot, "apps", "api", "dist", "browser-host-main.js");
  const traced = existsSync(browserEntry)
    ? traceLocalAndExternalImports([browserEntry])
    : { localFiles: [], externalPackages: ["@t3-oss/env-core", "nanoid", "zod"] };

  const allowlist = traced.localFiles.length > 0 ? new Set(traced.localFiles) : null;
  for (const ws of BROWSER_WORKSPACES) {
    stageWorkspacePackage(sourceRoot, outputDir, ws, {
      distFileAllowlist: ws === "apps/api" ? allowlist : null
    });
  }

  const seeds = traced.externalPackages.map((name) => ({
    fromDir: path.join(sourceRoot, "apps", "api"),
    name
  }));
  for (const ws of BROWSER_WORKSPACES) {
    if (ws === "apps/api") {
      continue;
    }
    const wsDir = path.join(sourceRoot, ws);
    const pkgJson = JSON.parse(readFileSync(path.join(wsDir, "package.json"), "utf8"));
    for (const depName of Object.keys(pkgJson.dependencies ?? {})) {
      seeds.push({ fromDir: wsDir, name: depName });
    }
  }

  const npmClosure = collectNpmDependencyClosure({
    sourceRoot,
    seeds,
    excludedPackages: new Set(["node-pty", "typescript"])
  });
  stageTargetNpmPackages(sourceRoot, outputDir, npmClosure);

  return {
    target: "browser",
    outputDir,
    workspaces: BROWSER_WORKSPACES,
    npmPackageCount: npmClosure.length
  };
}

export function stageCliTarget({ sourceRoot, outputDir, arch }) {
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  writeRootPackageManifest(sourceRoot, outputDir, { copyLockfile: false });

  for (const ws of CLI_WORKSPACES) {
    stageWorkspacePackage(sourceRoot, outputDir, ws);
  }

  copyDirectoryFiltered(
    path.join(sourceRoot, "agent-skills"),
    path.join(outputDir, "agent-skills")
  );

  const cliHostDir = path.join(sourceRoot, "packages", "cli-host");
  const cliHostPkg = JSON.parse(readFileSync(path.join(cliHostDir, "package.json"), "utf8"));
  const seeds = Object.keys(cliHostPkg.dependencies ?? {}).map((name) => ({
    fromDir: cliHostDir,
    name
  }));

  const npmClosure = collectNpmDependencyClosure({
    sourceRoot,
    seeds,
    excludedPackages: new Set(["typescript"])
  });
  stageTargetNpmPackages(sourceRoot, outputDir, npmClosure);
  pruneNodePty(outputDir, arch);

  return {
    target: "cli",
    outputDir,
    workspaces: CLI_WORKSPACES,
    npmPackageCount: npmClosure.length
  };
}

export function stageContainerRuntime({
  sourceRoot = process.cwd(),
  outputRoot,
  arch = process.env.TARGETARCH || process.arch,
  targets = CONTAINER_TARGETS
}) {
  if (!outputRoot) {
    throw new Error("outputRoot is required");
  }
  const resolvedSource = path.resolve(sourceRoot);
  const resolvedOutput = path.resolve(outputRoot);
  const results = {};

  for (const target of targets) {
    const targetDir = path.join(resolvedOutput, target);
    if (target === "core") {
      results.core = stageCoreTarget({ sourceRoot: resolvedSource, outputDir: targetDir, arch });
    } else if (target === "browser") {
      results.browser = stageBrowserTarget({ sourceRoot: resolvedSource, outputDir: targetDir });
    } else if (target === "cli") {
      results.cli = stageCliTarget({ sourceRoot: resolvedSource, outputDir: targetDir, arch });
    } else {
      throw new Error(`Unknown container target: ${target}`);
    }
  }

  return results;
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function runStageContainerRuntimeCli(args = process.argv.slice(2)) {
  const sourceRoot = optionValue(args, "--source") ?? process.cwd();
  const outputRoot = optionValue(args, "--output");
  const arch = optionValue(args, "--arch") ?? process.env.TARGETARCH ?? process.arch;
  const singleTarget = optionValue(args, "--target");
  if (!outputRoot) {
    throw new Error(
      "Usage: stage-container-runtime.mjs --output <dir> [--source <dir>] [--arch <amd64|arm64>] [--target <core|browser|cli>]"
    );
  }
  const targets = singleTarget ? [singleTarget] : CONTAINER_TARGETS;
  return stageContainerRuntime({ sourceRoot, outputRoot, arch, targets });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runStageContainerRuntimeCli();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
