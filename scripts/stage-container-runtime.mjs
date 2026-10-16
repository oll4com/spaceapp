#!/usr/bin/env node
// Stage independent /app trees before Docker creates its runtime layers. In
// particular, deleting a dependency in a later Docker layer cannot save bytes.
import { isBuiltin } from "node:module";
import { cp, lstat, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as vm from "node:vm";

const targets = ["core", "browser", "cli"];
const notices = ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"];
const ownerScripts = ["reset-owner-password.mjs", "rotate-owner-setup-token.mjs", "portable-backup.mjs", "portable-restore.mjs"];

function currentPlatform() {
  return {
    os: process.platform,
    cpu: process.arch,
    ...(process.platform === "linux" ? { libc: process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl" } : {})
  };
}

function matchesPlatformRule(rule, value) {
  if (!rule) return true;
  const values = Array.isArray(rule) ? rule : [rule];
  if (values.includes(`!${value}`)) return false;
  const allowed = values.filter((entry) => !entry.startsWith("!"));
  return allowed.length === 0 || allowed.includes("any") || allowed.includes(value);
}

export function packageMatchesPlatform(manifest, platform) {
  return matchesPlatformRule(manifest.os, platform.os)
    && matchesPlatformRule(manifest.cpu, platform.cpu)
    && (platform.os !== "linux" || matchesPlatformRule(manifest.libc, platform.libc));
}

// These are the paths selected by the pinned packages' own native loaders:
// @temporalio/core-bridge/common.js and node-pty/lib/utils.js. The build executes
// under the target architecture, so build/Release is already compiled for it.
async function nativePackageFilter(packageRoot, manifest, platform) {
  let temporalTarget;
  if (manifest.name === "@temporalio/core-bridge" && platform.os === "linux") {
    const architecture = { x64: "x86_64", arm64: "aarch64" }[platform.cpu];
    if (!architecture || platform.libc !== "glibc") throw new Error(`Unsupported Temporal runtime platform: ${JSON.stringify(platform)}`);
    temporalTarget = `${architecture}-unknown-linux-gnu`;
    if (!await exists(join(packageRoot, "releases", temporalTarget, "index.node"))) {
      throw new Error(`Missing Temporal native binary for ${temporalTarget}`);
    }
  }
  const ptyTarget = `${platform.os}-${platform.cpu}`;
  if (manifest.name === "node-pty" && platform.os === "linux") {
    const paths = ["build/Release/pty.node", "build/Debug/pty.node", `prebuilds/${ptyTarget}/pty.node`];
    if (!(await Promise.all(paths.map((path) => exists(join(packageRoot, path))))).some(Boolean)) {
      throw new Error(`Missing node-pty native binary for ${ptyTarget}`);
    }
  }
  const temporalBuildInputs = new Set(["bridge-macros", "scripts", "src", "sdk-core", "ts", "Cargo.toml", "Cargo.lock"]);
  return async (path) => {
    const local = relative(packageRoot, path);
    const parts = local.split(sep);
    if (parts.includes("node_modules") || !dependencyFile(path)) return false;
    if (temporalTarget) {
      if (parts[0] === "releases" && parts[1] && parts[1] !== temporalTarget) return false;
      if (temporalBuildInputs.has(parts[0])) {
        // Rust/TypeScript sources and build scripts are not read by the runtime
        // loader. Retain embedded legal files even inside those source trees.
        if (/^(?:licen[cs]e|notice|copying|copyright)(?:[._-].*)?$/i.test(basename(path))) return true;
        return (await lstat(path)).isDirectory();
      }
    }
    if (manifest.name === "node-pty" && parts[0] === "prebuilds" && parts[1] && parts[1] !== ptyTarget) return false;
    return true;
  };
}

function inside(root, path) {
  const name = relative(root, path);
  if (name === ".." || name.startsWith(`..${sep}`) || isAbsolute(name)) {
    throw new Error(`Runtime path is outside the repository: ${path}`);
  }
  return name;
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return false;
  }
}

function runtimeFile(path) {
  return !/\.(?:[cm]?js|css)\.map$|\.d\.(?:ts|mts|cts)(?:\.map)?$|(?:^|[/\\])__tests__(?:[/\\]|$)|\.(?:test|spec)\.[cm]?js$/.test(path);
}

function dependencyFile(path) {
  // Keep dependency-owned assets, including TypeScript's standard libraries and
  // native loader/build files. Only the source maps stripped by the old build
  // are omitted; package layouts are otherwise opaque to the application.
  return !/\.(?:[cm]?js|css)\.map$/.test(path);
}

async function copyPath(root, destination, source, options = {}) {
  const sourcePath = resolve(root, source);
  const output = join(destination, inside(root, sourcePath));
  await mkdir(dirname(output), { recursive: true });
  await cp(sourcePath, output, { recursive: true, verbatimSymlinks: true, ...options });
}

// Node's package lookup, without requiring an entry point (some dependencies
// expose only subpaths). Keep the installed path so nested versions stay nested.
async function installedDependency(root, from, name, optional = false) {
  let directory = from;
  while (true) {
    const candidate = join(directory, "node_modules", name);
    if (basename(directory) !== "node_modules" && await exists(join(candidate, "package.json"))) {
      inside(root, candidate);
      inside(root, await realpath(candidate));
      return candidate;
    }
    if (directory === root) break;
    const parent = dirname(directory);
    inside(root, parent);
    directory = parent;
  }
  if (optional) return null;
  throw new Error(`Missing production dependency ${name} required by ${inside(root, from) || "."}`);
}

/**
 * Copy the installed production closure, preserving npm's hoisted/nested layout
 * and workspace links. npm ci and npm prune must run first on the target OS and
 * architecture, so native binaries and platform-specific optional deps match.
 * roots are repository-relative package directories, not package names.
 */
export async function stageProductionDependencies({ root, destination, roots, platform = currentPlatform() }) {
  root = await realpath(resolve(root));
  destination = resolve(destination);
  if (destination === root) throw new Error("Runtime destination must differ from the repository");
  const seen = new Set();
  const links = new Map();
  const packages = [];

  async function visit(installedPath, optionalPackage = false) {
    const packageRoot = await realpath(installedPath);
    const packagePath = inside(root, packageRoot);
    const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
    if (!packageMatchesPlatform(manifest, platform)) {
      if (optionalPackage) return;
      throw new Error(`Production dependency ${manifest.name} is incompatible with ${JSON.stringify(platform)}`);
    }
    if (installedPath !== packageRoot) links.set(inside(root, installedPath), packagePath);
    if (seen.has(packageRoot)) return;
    seen.add(packageRoot);
    // A workspace symlink points to a first-party package outside node_modules.
    // Only its build output and package metadata belong in a runtime image.
    const workspace = !packagePath.split(sep).includes("node_modules");
    if (workspace) {
      await copyPath(root, destination, join(packagePath, "package.json"));
      await copyPath(root, destination, join(packagePath, "dist"), { filter: runtimeFile });
      if (packagePath === join("packages", "db")) await copyPath(root, destination, join(packagePath, "migrations"));
      if (packagePath === join("packages", "gateway")) await copyPath(root, destination, join(packagePath, "grammars"));
      for (const notice of notices) {
        if (await exists(join(packageRoot, notice))) await copyPath(root, destination, join(packagePath, notice));
      }
    } else {
      await copyPath(root, destination, packagePath, {
        filter: await nativePackageFilter(packageRoot, manifest, platform)
      });
    }
    packages.push({ name: manifest.name, version: manifest.version, path: packagePath.split(sep).join("/") });

    const optional = manifest.optionalDependencies ?? {};
    const dependencies = { ...manifest.dependencies, ...optional };
    // Non-optional peers are part of npm's installed production graph too.
    // Keep installed optional peers: packages may use them when available.
    for (const [name] of Object.entries(manifest.peerDependencies ?? {})) {
      if (!(name in dependencies)) {
        const optionalPeer = manifest.peerDependenciesMeta?.[name]?.optional === true;
        // This pinned package's optional TypeScript peer constrains consumers'
        // type checking. Its published dist/*.js never imports the compiler;
        // Temporal's workflow bundler uses swc-loader instead. Exclude only this
        // edge: another production dependency can still require TypeScript.
        if (manifest.name === "@t3-oss/env-core" && manifest.version === "0.13.11" && name === "typescript" && optionalPeer) continue;
        const dependency = await installedDependency(root, packageRoot, name, optionalPeer);
        if (dependency) await visit(dependency, optionalPeer);
      }
    }
    for (const name of Object.keys(dependencies).sort()) {
      const dependency = await installedDependency(root, packageRoot, name, Object.hasOwn(optional, name));
      if (dependency) await visit(dependency, Object.hasOwn(optional, name));
    }
  }

  await mkdir(destination, { recursive: true });
  for (const name of roots) await visit(resolve(root, name));
  for (const [link, target] of links) {
    const output = join(destination, link);
    await mkdir(dirname(output), { recursive: true });
    const targetPath = join(destination, target);
    await symlink(
      process.platform === "win32" ? targetPath : relative(dirname(output), targetPath),
      output,
      process.platform === "win32" ? "junction" : "dir"
    );
  }
  return packages.sort((left, right) => left.path.localeCompare(right.path));
}

// Browser Host lives in the API workspace but does not execute the API server.
// Parse its compiled ESM graph with Node itself, rather than copying the API's
// PDF, mail, Temporal, PTY and other unrelated production dependencies.
export async function browserEntrypointClosure(root) {
  if (typeof vm.SourceTextModule !== "function") {
    throw new Error("Runtime staging requires node --experimental-vm-modules");
  }
  root = await realpath(resolve(root));
  const files = new Set();
  const packages = new Set();
  async function visit(path) {
    inside(root, path);
    if (files.has(path)) return;
    files.add(path);
    const code = await readFile(path, "utf8");
    const module = new vm.SourceTextModule(code, { identifier: path });
    for (const specifier of module.dependencySpecifiers) {
      // Prefix-only builtins such as node:sqlite are intentionally absent from
      // builtinModules; Node's own predicate handles those without treating them
      // as npm packages.
      if (isBuiltin(specifier)) continue;
      if (specifier.startsWith(".")) {
        await visit(resolve(dirname(path), specifier));
      } else {
        const name = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        packages.add(inside(root, await installedDependency(root, dirname(path), name)));
      }
    }
  }
  await visit(join(root, "apps/api/dist/browser-host-main.js"));
  return { files: [...files].map((path) => inside(root, path)).sort(), roots: [...packages].sort() };
}

export async function stageContainerRuntime({ root = resolve(dirname(fileURLToPath(import.meta.url)), ".."), outputRoot, targets: selected = targets, platform = currentPlatform() }) {
  root = await realpath(resolve(root));
  if (!outputRoot) throw new Error("Runtime output directory is required");
  outputRoot = resolve(outputRoot);
  const results = {};
  for (const target of selected) {
    if (!targets.includes(target)) throw new Error(`Unknown container target: ${target}`);
    const destination = join(outputRoot, target);
    // Reusing a staged directory can retain dependencies no longer in a closure.
    if (await exists(destination)) throw new Error(`Runtime output already exists: ${destination}`);
    await mkdir(destination, { recursive: true });
    await copyPath(root, destination, "package.json");
    for (const notice of notices) await copyPath(root, destination, notice);
    let roots;
    if (target === "core") {
      roots = ["apps/api", "apps/worker"];
      await copyPath(root, destination, "apps/web/server.mjs");
      await copyPath(root, destination, "apps/web/package.json");
      await copyPath(root, destination, "apps/web/dist", { filter: runtimeFile });
      await copyPath(root, destination, "agent-skills");
      for (const script of ownerScripts) await copyPath(root, destination, `scripts/${script}`);
    } else if (target === "browser") {
      const closure = await browserEntrypointClosure(root);
      roots = closure.roots;
      for (const file of closure.files) await copyPath(root, destination, file);
      // package-version.js reads this relative to its compiled location.
      await copyPath(root, destination, "apps/api/package.json");
    } else {
      roots = ["packages/cli-host"];
      await copyPath(root, destination, "agent-skills");
    }
    const packages = await stageProductionDependencies({ root, destination, roots, platform });
    results[target] = { packages };
    await writeFile(join(destination, "runtime-packages.json"), `${JSON.stringify({ target, packages }, null, 2)}\n`);
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 2 || args[0] !== "--output") throw new Error("Usage: node --experimental-vm-modules scripts/stage-container-runtime.mjs --output <directory>");
    const result = await stageContainerRuntime({ outputRoot: args[1] });
    for (const [target, { packages }] of Object.entries(result)) process.stdout.write(`Staged ${target}: ${packages.length} production packages\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
