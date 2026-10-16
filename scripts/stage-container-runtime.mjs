#!/usr/bin/env node
import { isBuiltin, createRequire } from "node:module";
import { cp, lstat, mkdir, open, readFile, readdir, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const codeExtension = /\.(?:[cm]?js)$/;
const ownerScripts = ["reset-owner-password.mjs", "rotate-owner-setup-token.mjs", "portable-backup.mjs", "portable-restore.mjs"];
const entrypoints = Object.freeze({
  core: ["apps/api/dist/server.js", "apps/worker/dist/worker.js", "apps/web/server.mjs", "packages/db/dist/migrate.js",
    "deploy/docker/core-supervisor.mjs", ...ownerScripts.map((name) => `scripts/${name}`)],
  browser: ["apps/api/dist/browser-host-main.js"],
  cli: ["packages/cli-host/dist/main.js", "deploy/docker/credential-agent.mjs", "deploy/docker/provider-install.mjs",
    "deploy/docker/credential-install.mjs", "deploy/docker/opencode-first-run.mjs"]
});

/** Returns a portable path relative to a root, rejecting files outside that tree. */
function inside(root, filename) {
  const result = relative(root, filename);
  if (isAbsolute(result) || result === ".." || result.startsWith(`..${sep}`)) throw new Error(`Path escapes the source tree: ${filename}`);
  return result.split(sep).join("/");
}

/** Reads package metadata without executing package code or lifecycle scripts. */
async function metadata(directory) {
  return JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
}

/** Tests for an existing path while preserving permission and other I/O failures. */
async function exists(filename) {
  try { await lstat(filename); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

/** Canonicalizes the existing parent of a future output, including symlinked roots. */
async function futureRealpath(filename) {
  const absolute = resolve(filename);
  let parent = absolute;
  while (!await exists(parent)) parent = dirname(parent);
  return resolve(await realpath(parent), relative(parent, absolute));
}

/** Extracts the package name from a bare specifier, including scoped names. */
function packageName(specifier) {
  return specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
}

/** Resolves the installed package at the same node_modules location Node would use. */
async function installedPackage(root, importer, name, optional = false) {
  let directory = dirname(importer);
  for (;;) {
    const candidate = join(directory, "node_modules", name);
    if (await exists(join(candidate, "package.json"))) {
      inside(root, candidate);
      inside(root, await realpath(candidate));
      return candidate;
    }
    if (directory === root) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  if (optional) return undefined;
  throw new Error(`Required runtime package ${name} is not installed (from ${inside(root, importer)}).`);
}

/** Selects a Node import/require conditional export, ignoring type-only branches. */
function conditionalExport(value, kind) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => conditionalExport(item, kind)).find(Boolean);
  if (!value || typeof value !== "object") return undefined;
  for (const [condition, target] of Object.entries(value)) {
    if (["node", kind, "default"].includes(condition)) {
      const selected = conditionalExport(target, kind);
      if (selected) return selected;
    }
  }
  return undefined;
}

/** Resolves exact and wildcard workspace exports without copying unrelated exports. */
function workspaceExport(manifest, specifier, kind) {
  const name = packageName(specifier);
  const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
  if (manifest.exports !== undefined) {
    const exports = manifest.exports;
    if (typeof exports === "object" && exports && !Array.isArray(exports) && Object.keys(exports).some((key) => key.startsWith("."))) {
      if (Object.hasOwn(exports, subpath)) return conditionalExport(exports[subpath], kind);
      for (const key of Object.keys(exports).filter((key) => key.includes("*")).sort((a, b) => b.length - a.length)) {
        const [prefix, suffix] = key.split("*");
        if (subpath.startsWith(prefix) && subpath.endsWith(suffix)) {
          const selected = conditionalExport(exports[key], kind);
          if (selected) return selected.replaceAll("*", subpath.slice(prefix.length, suffix ? -suffix.length : undefined));
        }
      }
      return undefined;
    }
    return subpath === "." ? conditionalExport(exports, kind) : undefined;
  }
  return subpath === "." ? manifest.main ?? "index.js" : subpath;
}

/** Finds emitted code or JSON for a Node module edge and fails on missing code. */
async function moduleFile(filename, kind = "import") {
  const candidates = kind === "require"
    ? [filename, `${filename}.js`, `${filename}.cjs`, `${filename}.json`, join(filename, "index.js")]
    : [filename];
  for (const candidate of candidates) if (await exists(candidate) && (await stat(candidate)).isFile()) return candidate;
  throw new Error(`Required emitted runtime module is missing: ${filename}. Run npm run build first.`);
}

/** Extracts executable imports and statically named import.meta/__dirname assets. */
function moduleEdges(filename, text) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse emitted runtime module: ${filename}`);
  const imports = [], assets = [], packageAssets = [];
  const literal = (node) => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && !node.isTypeOnly) {
      imports.push({ specifier: node.moduleSpecifier.text, kind: "import" });
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        ts.isIdentifier(node.expression) && node.expression.text === "require" || node.expression.getText(source) === "import.meta.resolve")) {
      const specifier = literal(node.arguments[0]);
      if (specifier !== undefined) imports.push({ specifier, kind: node.expression.getText(source) === "require" ? "require" : "import" });
    }
    if (ts.isNewExpression(node) && node.expression.getText(source) === "URL" && node.arguments?.length === 2 &&
        node.arguments[1].getText(source) === "import.meta.url") {
      const value = literal(node.arguments[0]);
      if (value && ![".", "./", "..", "../"].includes(value) && !/^[a-z][a-z\d+.-]*:/i.test(value)) assets.push(resolve(dirname(filename), value));
    }
    if (ts.isNewExpression(node) && node.expression.getText(source) === "URL" && node.arguments?.length === 2 &&
        ts.isCallExpression(node.arguments[1]) && node.arguments[1].expression.getText(source) === "import.meta.resolve") {
      const value = literal(node.arguments[0]), specifier = literal(node.arguments[1].arguments[0]);
      if (value && specifier && !/^[a-z][a-z\d+.-]*:/i.test(value)) packageAssets.push({ value, specifier });
    }
    if (ts.isCallExpression(node) && /^(?:path\.)?join$/.test(node.expression.getText(source)) &&
        node.arguments[0]?.getText(source) === "__dirname") {
      const parts = node.arguments.slice(1).map(literal);
      if (parts.length && parts.every((part) => part !== undefined)) assets.push(resolve(dirname(filename), ...parts));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return { imports, assets, packageAssets };
}

/** Checks npm os/cpu selectors, including negative selectors, for this image. */
function platformMatches(manifest, architecture) {
  const matches = (selection, actual) => {
    const values = selection === undefined ? undefined : Array.isArray(selection) ? selection : [selection];
    return !values || !values.includes(`!${actual}`) &&
      (!values.some((value) => !value.startsWith("!")) || values.includes(actual) || values.includes("any"));
  };
  return matches(manifest.os, "linux") && matches(manifest.cpu, architecture) && matches(manifest.libc, "glibc");
}

/** Keeps only Linux ELF native addons matching the image CPU; rejects unknown formats. */
async function nativeAddonMatches(filename, architecture) {
  const handle = await open(filename, "r");
  const header = Buffer.alloc(20);
  let bytes;
  try { const read = await handle.read(header, 0, header.length, 0); bytes = header.subarray(0, read.bytesRead); }
  finally { await handle.close(); }
  if (bytes.length >= 20 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
    return machine === ({ x64: 62, arm64: 183 })[architecture];
  }
  if (bytes.subarray(0, 2).toString() === "MZ" ||
      ["feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca"].includes(bytes.subarray(0, 4).toString("hex"))) return false;
  throw new Error(`Unknown native addon format: ${filename}`);
}

/** Recognizes only published native-package prebuild layouts; unknown paths stay intact. */
function foreignPrebuildDirectory(name, packageRelative, architecture) {
  const [directory, platform] = packageRelative.split("/");
  if (name === "node-pty" && directory === "prebuilds" && /^(darwin|linux|win32)-(x64|arm64|ia32)$/.test(platform ?? "")) {
    return platform !== `linux-${architecture}`;
  }
  if (name === "@temporalio/core-bridge" && directory === "releases" &&
      /^(x86_64|aarch64|i686|armv7)-(apple-darwin|unknown-linux-(gnu|musl)|pc-windows-(msvc|gnu))$/.test(platform ?? "")) {
    return platform !== `${architecture === "x64" ? "x86_64" : "aarch64"}-unknown-linux-gnu`;
  }
  return false;
}

/** Stages a service's emitted module graph and installed production npm closure. */
export async function stageContainerRuntime({ target, output, sourceRoot = repositoryRoot, architecture = process.arch, sharedAssetsExternal = false }) {
  if (!Object.hasOwn(entrypoints, target)) throw new Error(`Unknown container target: ${target}`);
  if (!["x64", "arm64"].includes(architecture)) throw new Error(`Unsupported Linux container architecture: ${architecture}`);
  const root = await realpath(sourceRoot), destination = await futureRealpath(output);
  if (destination === root || root.startsWith(`${destination}${sep}`) || destination.startsWith(`${root}${sep}`)) {
    throw new Error("Runtime output must be a separate directory outside the source tree.");
  }
  if (await exists(destination) && (await readdir(destination)).length) throw new Error("Runtime output must be empty; refusing to overwrite existing files.");
  const rootMetadata = await metadata(root);
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  const workspaceDirectories = new Set();
  for (const prefix of ["apps", "packages"]) {
    for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
      const directory = join(root, prefix, item.name);
      if (item.isDirectory() && await exists(join(directory, "package.json"))) workspaceDirectories.add(await realpath(directory));
    }
  }
  const modules = new Set(), copyFiles = new Set(), copyDirectories = new Set(), packages = new Map(), links = new Map();
  const omittedNative = [], omittedOptional = [];
  const queue = entrypoints[target].map((item) => join(root, item));
  const skipShared = (p) => sharedAssetsExternal && (p.startsWith("deploy/docker/") ||
    ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"].includes(p) || ownerScripts.some((name) => p === `scripts/${name}`) || p.startsWith("starter-memory/"));

  /** Records a workspace's package scope while keeping only reached code modules. */
  async function addWorkspaceScope(filename) {
    let directory = dirname(filename);
    while (directory !== root) {
      if (workspaceDirectories.has(directory)) { copyFiles.add(join(directory, "package.json")); return; }
      directory = dirname(directory);
    }
  }

  /** Resolves a runtime import into workspace code or an installed npm dependency. */
  async function follow(importer, specifier, kind) {
    if (isBuiltin(specifier)) return;
    if (specifier.startsWith(".") || specifier.startsWith("file:")) {
      const filename = specifier.startsWith("file:") ? fileURLToPath(specifier) : fileURLToPath(new URL(specifier, pathToFileURL(importer)));
      inside(root, filename); queue.push(await moduleFile(filename, kind)); return;
    }
    if (isAbsolute(specifier) || specifier.startsWith("#")) throw new Error(`Unsupported runtime module edge ${specifier} in ${inside(root, importer)}`);
    const installed = await installedPackage(root, importer, packageName(specifier));
    const directory = await realpath(installed), manifest = await metadata(directory);
    if (workspaceDirectories.has(directory)) {
      const selected = workspaceExport(manifest, specifier, kind);
      if (!selected) throw new Error(`No ${kind} export for ${specifier}`);
      const filename = resolve(directory, selected);
      inside(directory, filename);
      links.set(inside(root, installed), inside(root, directory));
      copyFiles.add(join(directory, "package.json"));
      queue.push(await moduleFile(filename, kind));
    } else await addExternal(installed);
  }

  /** Includes a whole npm package and its installed production/optional/peer graph. */
  async function addExternal(directory) {
    const location = inside(root, directory);
    if (packages.has(location)) return;
    const manifest = await metadata(directory);
    if (!platformMatches(manifest, architecture)) throw new Error(`Required runtime package has incompatible platform: ${location}`);
    const locked = lock.packages?.[location];
    if (!locked || locked.link || locked.version !== manifest.version) throw new Error(`Installed package is not the locked version: ${location}`);
    packages.set(location, { name: manifest.name, version: manifest.version });
    const optional = new Set(Object.keys(manifest.optionalDependencies ?? {}));
    const dependencies = { ...manifest.dependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies };
    for (const name of Object.keys(dependencies).sort()) {
      const optionalEdge = optional.has(name) || !Object.hasOwn(manifest.dependencies ?? {}, name) && manifest.peerDependenciesMeta?.[name]?.optional === true;
      const installed = await installedPackage(root, join(directory, "package.json"), name, optionalEdge);
      if (!installed) continue;
      const actual = await realpath(installed);
      if (workspaceDirectories.has(actual)) throw new Error(`External package unexpectedly depends on workspace ${name}`);
      if (!platformMatches(await metadata(actual), architecture)) {
        if (!optionalEdge) throw new Error(`Required dependency has incompatible platform: ${name}`);
        omittedOptional.push(inside(root, installed)); continue;
      }
      await addExternal(installed);
    }
  }

  while (queue.length) {
    const filename = await realpath(await moduleFile(queue.shift()));
    inside(root, filename);
    if (modules.has(filename)) continue;
    modules.add(filename); copyFiles.add(filename); await addWorkspaceScope(filename);
    // Migration SQL is found via packageRoot rather than a literal import URL.
    if (inside(root, filename) === "packages/db/dist/migrations.js") copyDirectories.add(join(root, "packages/db/migrations"));
    if (!codeExtension.test(filename)) continue;
    const edges = moduleEdges(filename, await readFile(filename, "utf8"));
    for (const edge of edges.imports) await follow(filename, edge.specifier, edge.kind);
    for (const asset of edges.packageAssets) {
      const installed = await installedPackage(root, filename, packageName(asset.specifier));
      const directory = await realpath(installed);
      // Entire external package payloads are already retained by the import
      // edge. Workspace sibling executables need their own module graph.
      if (!workspaceDirectories.has(directory)) continue;
      const selected = workspaceExport(await metadata(directory), asset.specifier, "import");
      if (!selected) throw new Error(`No import export for runtime asset base ${asset.specifier}`);
      const assetPath = fileURLToPath(new URL(asset.value, pathToFileURL(resolve(directory, selected))));
      inside(root, assetPath); edges.assets.push(assetPath);
    }
    for (const asset of edges.assets) {
      inside(root, asset);
      // URL construction alone does not require an optional/version file to exist.
      if (!await exists(asset)) continue;
      if ((await stat(asset)).isDirectory()) {
        // A URL naming the module's parent is a dirname calculation, not an
        // instruction to copy the entire workspace or monorepo into an image.
        if (!filename.startsWith(`${asset}${sep}`)) copyDirectories.add(asset);
      }
      else if (codeExtension.test(asset)) queue.push(asset);
      else copyFiles.add(asset);
    }
  }
  copyFiles.add(join(root, "package.json")); copyFiles.add(join(root, "package-lock.json"));
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) copyFiles.add(join(root, name));
  copyDirectories.add(join(root, "deploy/docker"));
  if (target === "core") { copyDirectories.add(join(root, "apps/web/dist")); copyDirectories.add(join(root, "starter-memory")); }
  if (target === "core" || target === "cli") copyDirectories.add(join(root, "agent-skills"));
  await mkdir(destination, { recursive: true });

  /** Copies a selected payload, rejecting escaping links and unrelated nested installs. */
  async function copyPayload(source, external = false) {
    const sourceRelative = inside(root, source);
    if (skipShared(`${sourceRelative}/`) || skipShared(sourceRelative)) return;
    await cp(source, join(destination, sourceRelative), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true,
      filter: async (filename) => {
        const p = inside(root, filename);
        if (skipShared(p) || p.endsWith(".map")) return false;
        if (filename !== source && ["node_modules", ".git"].includes(filename.split(sep).at(-1))) return false;
        if (external && foreignPrebuildDirectory(packages.get(sourceRelative).name, relative(source, filename).split(sep).join("/"), architecture)) {
          omittedNative.push(p); return false;
        }
        const info = await lstat(filename);
        if (info.isSymbolicLink()) inside(root, await realpath(filename));
        if (external && info.isFile() && filename.endsWith(".node") && !await nativeAddonMatches(filename, architecture)) {
          omittedNative.push(p); return false;
        }
        return true;
      } });
  }
  for (const directory of [...copyDirectories].sort()) await copyPayload(directory);
  for (const filename of [...copyFiles].sort()) await copyPayload(filename);
  for (const location of [...packages.keys()].sort()) await copyPayload(join(root, location), true);
  for (const [location, workspace] of [...links].sort()) {
    const filename = join(destination, location);
    await mkdir(dirname(filename), { recursive: true });
    await symlink(relative(dirname(filename), join(destination, workspace)), filename);
  }
  const manifest = { format: 1, target, architecture, sharedAssetsExternal, sourcePackage: rootMetadata.name,
    entrypoints: entrypoints[target], workspaceModules: [...modules].map((p) => inside(root, p)).sort(),
    externalPackages: [...packages].map(([location, value]) => ({ location, ...value })).sort((a, b) => a.location.localeCompare(b.location)),
    omittedIncompatibleOptionalPackages: [...new Set(omittedOptional)].sort(), omittedForeignNativeAddons: omittedNative.sort() };
  await writeFile(join(destination, ".spaceapp-runtime-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Parses the staging CLI without executing package managers or deleting an output tree. */
export async function runStageContainerRuntime(args = process.argv.slice(2)) {
  const options = { sharedAssetsExternal: false };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--shared-assets-external") options.sharedAssetsExternal = true;
    else if (["--target", "--output"].includes(arg) && args[index + 1]) options[arg.slice(2)] = args[++index];
    else throw new Error(`Unknown or incomplete staging argument: ${arg}`);
  }
  if (!options.target || !options.output) throw new Error("Usage: stage-container-runtime.mjs --target <core|browser|cli> --output <empty-directory> [--shared-assets-external]");
  const result = await stageContainerRuntime(options);
  process.stdout.write(`${result.target}: ${result.workspaceModules.length} emitted modules, ${result.externalPackages.length} production npm packages (${result.architecture})\n`);
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await runStageContainerRuntime().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
