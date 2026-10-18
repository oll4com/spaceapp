#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rm, stat, symlink, realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TARGETS = new Set(["core", "browser", "cli"]);

const CORE_WORKSPACES = Object.freeze([
  "apps/api",
  "apps/worker",
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
  "packages/browser-host",
  "packages/contracts",
  "packages/db",
  "packages/memory-graph",
  "packages/runtime"
]);

const BROWSER_SEED_PACKAGES = Object.freeze([
  "@t3-oss/env-core",
  "nanoid",
  "zod",
  "pg",
  "graphology",
  "graphology-layout-forceatlas2",
  "mdast-util-from-markdown"
]);

const CLI_WORKSPACES = Object.freeze(["packages/cli-host"]);
const CLI_SEED_PACKAGES = Object.freeze(["node-pty"]);

export function normalizeCpuArch(targetArch = process.arch) {
  const value = String(targetArch).trim().toLowerCase();
  if (value === "amd64" || value === "x64" || value === "x86_64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  throw new Error(`Unsupported container architecture: ${targetArch}`);
}

export function resolveTargetSpec(target) {
  if (!TARGETS.has(target)) throw new Error(`Unknown container target: ${target}`);
  if (target === "cli") {
    return {
      target,
      workspaces: [...CLI_WORKSPACES],
      includeWebDist: false,
      includeAgentSkills: true,
      includeCoreScripts: false
    };
  }
  if (target === "browser") {
    return {
      target,
      workspaces: ["apps/api", ...BROWSER_WORKSPACES],
      includeWebDist: false,
      includeAgentSkills: false,
      includeCoreScripts: false
    };
  }
  return {
    target,
    workspaces: [...CORE_WORKSPACES],
    includeWebDist: true,
    includeAgentSkills: true,
    includeCoreScripts: true
  };
}

export function resolveSeedPackages(target, lockfile) {
  if (!TARGETS.has(target)) throw new Error(`Unknown container target: ${target}`);
  if (target === "cli") return [...CLI_SEED_PACKAGES];
  if (target === "browser") return [...BROWSER_SEED_PACKAGES];

  const packages = lockfile?.packages ?? {};
  const seeds = new Set(["@modelcontextprotocol/sdk", "ws"]);
  for (const workspace of CORE_WORKSPACES) {
    const manifest = packages[workspace] ?? {};
    for (const dep of Object.keys(manifest.dependencies ?? {})) {
      if (dep.startsWith("@space/") || dep === "node-pty") continue;
      seeds.add(dep);
    }
  }
  return [...seeds].sort();
}

function platformMatches(values, platform) {
  const positive = values.filter((value) => !value.startsWith("!"));
  return !values.includes(`!${platform}`) && (positive.length === 0 || positive.includes(platform));
}

function isCompatiblePlatformPackage(key, meta, cpuArch) {
  const osList = Array.isArray(meta?.os) ? meta.os : null;
  if (osList && !platformMatches(osList, "linux")) return false;
  const cpuList = Array.isArray(meta?.cpu) ? meta.cpu : null;
  if (cpuList && !platformMatches(cpuList, cpuArch)) return false;
  if (/-musl($|-)/.test(key)) return false;
  return true;
}

export function resolveNodeModulesClosure({ target, lockfile, targetArch = process.arch, seedPackages = [] }) {
  const cpuArch = normalizeCpuArch(targetArch);
  const packages = lockfile?.packages ?? {};
  const seeds = [...resolveSeedPackages(target, lockfile), ...seedPackages];
  const visited = new Set();
  const queue = target === "core"
    ? ["@modelcontextprotocol/sdk", "ws"].map((name) => ({ name, fromPath: "" }))
    : seeds.map((name) => ({ name, fromPath: target === "browser" ? "apps/api" : "packages/cli-host" }));
  if (target === "browser") {
    for (const workspace of BROWSER_WORKSPACES) {
      for (const name of Object.keys(packages[workspace]?.dependencies ?? {})) {
        if (!name.startsWith("@space/")) queue.push({ name, fromPath: workspace });
      }
    }
  }
  if (target === "core") {
    for (const workspace of CORE_WORKSPACES) {
      for (const name of Object.keys(packages[workspace]?.dependencies ?? {})) {
        if (!name.startsWith("@space/") && name !== "node-pty") queue.push({ name, fromPath: workspace });
      }
    }
    for (const name of seedPackages) queue.push({ name, fromPath: "" });
  }

  function resolveKey(name, fromPath) {
    let scope = fromPath;
    while (scope) {
      const candidate = `${scope}/node_modules/${name}`;
      if (Object.hasOwn(packages, candidate)) return candidate;
      const parentIndex = scope.lastIndexOf("/node_modules/");
      scope = parentIndex > 0 ? scope.slice(0, parentIndex) : "";
    }
    const rootCandidate = `node_modules/${name}`;
    return Object.hasOwn(packages, rootCandidate) ? rootCandidate : null;
  }

  while (queue.length > 0) {
    const { name, fromPath, optional = false } = queue.shift();
    const key = resolveKey(name, fromPath);
    if (!key) {
      if (optional) continue;
      throw new Error(`Missing required dependency ${name} from ${fromPath || target}`);
    }
    if (visited.has(key)) continue;
    const meta = packages[key];
    if (!isCompatiblePlatformPackage(key, meta, cpuArch)) {
      if (optional) continue;
      throw new Error(`Required dependency ${key} is incompatible with linux/${cpuArch}`);
    }
    visited.add(key);

    for (const dep of Object.keys(meta?.dependencies ?? {})) {
      if (!dep.startsWith("@space/") && !Object.hasOwn(meta.optionalDependencies ?? {}, dep)) {
        queue.push({ name: dep, fromPath: key });
      }
    }
    for (const dep of Object.keys(meta?.peerDependencies ?? {})) {
      if (dep.startsWith("@space/")) continue;
      const optionalPeer = meta.peerDependenciesMeta?.[dep]?.optional === true;
      const peerKey = resolveKey(dep, key);
      if (optionalPeer && (!peerKey || packages[peerKey].dev === true)) continue;
      queue.push({ name: dep, fromPath: key, optional: optionalPeer });
    }
    for (const dep of Object.keys(meta?.optionalDependencies ?? {})) {
      if (!dep.startsWith("@space/")) queue.push({ name: dep, fromPath: key, optional: true });
    }
  }
  return [...visited].sort();
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function stripNonRuntimeFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") {
        await rm(fullPath, { recursive: true });
        continue;
      }
      await stripNonRuntimeFiles(fullPath);
      continue;
    }
    if (
      entry.isFile() &&
      (/\.(?:d\.[cm]?ts|[cm]?js\.map|css\.map|d\.ts\.map|(?:test|spec)\.[cm]?js)$/i.test(entry.name) ||
        /^(?:README|CHANGELOG|HISTORY|CONTRIBUTING)\.md$/i.test(entry.name))
    ) {
      await rm(fullPath, { force: true });
    }
  }
}

async function pruneNativePrebuilds(targetRoot, cpuArch) {
  const temporalReleasesDir = join(targetRoot, "node_modules/@temporalio/core-bridge/releases");
  if (await exists(temporalReleasesDir)) {
    const expectedTriple =
      cpuArch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    for (const entry of await readdir(temporalReleasesDir)) {
      if (entry !== expectedTriple) {
        await rm(join(temporalReleasesDir, entry), { recursive: true, force: true });
      }
    }
  }

  const nodePtyPrebuildsDir = join(targetRoot, "node_modules/node-pty/prebuilds");
  if (await exists(nodePtyPrebuildsDir)) {
    const expectedPrebuild = `linux-${cpuArch}`;
    for (const entry of await readdir(nodePtyPrebuildsDir)) {
      if (entry !== expectedPrebuild) {
        await rm(join(nodePtyPrebuildsDir, entry), { recursive: true, force: true });
      }
    }
  }
}

async function copyWorkspaceRuntime(sourceRoot, targetRoot, workspace, browserFiles) {
  const srcWorkspace = join(sourceRoot, workspace);
  const dstWorkspace = join(targetRoot, workspace);
  await mkdir(dstWorkspace, { recursive: true });
  await cp(join(srcWorkspace, "package.json"), join(dstWorkspace, "package.json"));

  const distPath = join(srcWorkspace, "dist");
  if (workspace === "apps/api" && browserFiles) {
    for (const file of browserFiles) {
      const destination = join(targetRoot, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(sourceRoot, file), destination);
    }
  } else {
    await cp(distPath, join(dstWorkspace, "dist"), { recursive: true });
  }
  if (workspace === "packages/db" && (await exists(join(srcWorkspace, "migrations")))) {
    await cp(join(srcWorkspace, "migrations"), join(dstWorkspace, "migrations"), { recursive: true });
  }
  if (workspace === "packages/gateway" && (await exists(join(srcWorkspace, "grammars")))) {
    await cp(join(srcWorkspace, "grammars"), join(dstWorkspace, "grammars"), { recursive: true });
  }
  await stripNonRuntimeFiles(dstWorkspace);
}

// Build-time parser: retain the browser entrypoint's complete local import graph,
// including lazy literal imports, without copying unrelated API routes or tests.
export async function collectBrowserRuntimeFiles(sourceRoot) {
  const { default: ts } = await import("typescript");
  const files = new Set();
  const externalPackages = new Set();
  const queue = ["apps/api/dist/browser-host-main.js"];
  while (queue.length) {
    const file = queue.shift();
    if (files.has(file)) continue;
    if (!file.startsWith("apps/api/dist/")) throw new Error(`Browser import escapes API dist: ${file}`);
    files.add(file);
    const source = ts.createSourceFile(file, await readFile(join(sourceRoot, file), "utf8"),
      ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
        specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteral(specifier)) {
          throw new Error(`Nonliteral browser module load requires an explicit runtime asset rule: ${file}`);
        }
      }
      if (specifier && ts.isStringLiteral(specifier)) {
        const name = specifier.text;
        if (name.startsWith(".")) queue.push(relative(sourceRoot, resolve(sourceRoot, dirname(file), name)));
        else if (!name.startsWith("node:") && !name.startsWith("@space/")) {
          externalPackages.add(name.startsWith("@") ? name.split("/").slice(0, 2).join("/") : name.split("/")[0]);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { files: [...files].sort(), externalPackages: [...externalPackages].sort() };
}

export async function prepareContainerTarget({
  sourceRoot,
  outputRoot,
  target,
  targetArch = process.arch
}) {
  async function canonical(path) {
    try { return await realpath(path); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      return join(await canonical(dirname(path)), basename(path));
    }
  }
  sourceRoot = await canonical(resolve(sourceRoot));
  outputRoot = await canonical(resolve(outputRoot));
  // Never let the cleanup step erase the checkout or generate outputs inside it.
  const overlaps = (a, b) => a === b || a.startsWith(b.endsWith(sep) ? b : `${b}${sep}`);
  if (overlaps(sourceRoot, outputRoot) || overlaps(outputRoot, sourceRoot)) {
    throw new Error("Container output must be outside the source tree and its ancestors");
  }
  const cpuArch = normalizeCpuArch(targetArch);
  const spec = resolveTargetSpec(target);
  const lockfile = JSON.parse(await readFile(join(sourceRoot, "package-lock.json"), "utf8"));
  const browserGraph = target === "browser" ? await collectBrowserRuntimeFiles(sourceRoot) : null;
  const closure = resolveNodeModulesClosure({ target, lockfile, targetArch: cpuArch,
    seedPackages: browserGraph?.externalPackages ?? [] });
  const destination = join(outputRoot, target);

  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(join(sourceRoot, "package.json"), join(destination, "package.json"));
  await cp(join(sourceRoot, "package-lock.json"), join(destination, "package-lock.json"));

  for (const modulePath of closure) {
    const srcModule = join(sourceRoot, modulePath);
    if (!(await exists(srcModule))) throw new Error(`Required runtime package is not installed: ${modulePath}`);
    const dstModule = join(destination, modulePath);
    await mkdir(dirname(dstModule), { recursive: true });
    await cp(srcModule, dstModule, {
      recursive: true,
      filter: (sourcePath) =>
        sourcePath === srcModule || !sourcePath.slice(srcModule.length).startsWith("/node_modules")
    });
  }

  for (const workspace of spec.workspaces) {
    await copyWorkspaceRuntime(sourceRoot, destination, workspace, browserGraph?.files);
    if (workspace.startsWith("packages/")) {
      const pkgName = `@space/${workspace.slice("packages/".length)}`;
      const dstLink = join(destination, "node_modules", pkgName);
      await rm(dstLink, { recursive: true, force: true });
      await mkdir(dirname(dstLink), { recursive: true });
      await symlink(relative(dirname(dstLink), join(destination, workspace)), dstLink, "dir");
    }
  }

  if (spec.includeWebDist) {
    const dstWeb = join(destination, "apps/web");
    await mkdir(dstWeb, { recursive: true });
    await cp(join(sourceRoot, "apps/web/package.json"), join(dstWeb, "package.json"));
    await cp(join(sourceRoot, "apps/web/server.mjs"), join(dstWeb, "server.mjs"));
    await cp(join(sourceRoot, "apps/web/dist"), join(dstWeb, "dist"), { recursive: true });
  }

  if (spec.includeAgentSkills) {
    await cp(join(sourceRoot, "agent-skills"), join(destination, "agent-skills"), { recursive: true });
  }

  if (spec.includeCoreScripts) {
    const dstScripts = join(destination, "scripts");
    await mkdir(dstScripts, { recursive: true });
    for (const scriptName of [
      "reset-owner-password.mjs",
      "rotate-owner-setup-token.mjs",
      "portable-backup.mjs",
      "portable-restore.mjs",
      "cli-render-fixture.mjs"
    ]) {
      await cp(join(sourceRoot, "scripts", scriptName), join(dstScripts, scriptName));
    }
  }

  await pruneNativePrebuilds(destination, cpuArch);
  await stripNonRuntimeFiles(join(destination, "node_modules"));

  return {
    target,
    cpuArch,
    destination,
    workspaces: spec.workspaces,
    packageCount: closure.length
  };
}

function optionValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export async function runPrepareContainerTargets(args = process.argv.slice(2)) {
  const sourceRoot = resolve(
    optionValue(args, "--source") ?? resolve(dirname(fileURLToPath(import.meta.url)), "..")
  );
  const outputRoot = resolve(optionValue(args, "--output") ?? "/out");
  const targetArch = optionValue(args, "--arch") ?? process.env.TARGETARCH ?? process.arch;
  const requestedTarget = optionValue(args, "--target");
  const targets = requestedTarget ? [requestedTarget] : ["core", "browser", "cli"];
  const results = [];
  for (const target of targets) {
    results.push(await prepareContainerTarget({ sourceRoot, outputRoot, target, targetArch }));
  }
  return results;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPrepareContainerTargets().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}
`);
    process.exitCode = 1;
  });
}
