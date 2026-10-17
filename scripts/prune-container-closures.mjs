#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");

/**
 * Parses CLI arguments into an options map.
 * @param {string[]} args
 * @returns {{ targetArch: string, outputDir: string }}
 */
export function parseArgs(args = process.argv.slice(2)) {
  let targetArch = process.env.TARGETARCH || (process.arch === "arm64" ? "arm64" : "amd64");
  let outputDir = join(repoRoot, "closures");

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--targetarch" && args[i + 1]) {
      targetArch = args[++i];
    } else if (args[i] === "--output-dir" && args[i + 1]) {
      outputDir = resolve(args[++i]);
    }
  }

  return { targetArch, outputDir };
}

/**
 * Recursively deletes any .map files from a directory.
 * @param {string} dir
 */
export function removeSourceMaps(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeSourceMaps(full);
    } else if (entry.isFile() && entry.name.endsWith(".map")) {
      unlinkSync(full);
    }
  }
}

/**
 * Recursively resolves production dependencies for a set of root packages.
 * @param {string} nodeModulesDir
 * @param {string[]} rootPackages
 * @returns {Set<string>}
 */
export function resolveDependencyClosure(nodeModulesDir, rootPackages) {
  const collected = new Set();
  const queue = [...rootPackages];

  while (queue.length > 0) {
    const pkg = queue.shift();
    if (!pkg || collected.has(pkg)) continue;
    collected.add(pkg);

    const pkgJsonPath = join(nodeModulesDir, pkg, "package.json");
    if (existsSync(pkgJsonPath)) {
      try {
        const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
        const deps = Object.keys(pkgJson.dependencies || {});
        for (const dep of deps) {
          if (!collected.has(dep)) {
            queue.push(dep);
          }
        }
      } catch {
        // Skip unparseable package.json
      }
    }
  }

  return collected;
}

/**
 * Builds the standalone CLI container closure.
 * @param {string} root
 * @param {string} targetDir
 * @param {string} targetArch
 */
export function buildCliClosure(root, targetDir, targetArch) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // Root files
  cpSync(join(root, "package.json"), join(targetDir, "package.json"));
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    const src = join(root, file);
    if (existsSync(src)) cpSync(src, join(targetDir, file));
  }

  // Workspaces: packages/cli-host
  const cliHostSrc = join(root, "packages", "cli-host");
  const cliHostDst = join(targetDir, "packages", "cli-host");
  mkdirSync(cliHostDst, { recursive: true });
  cpSync(join(cliHostSrc, "package.json"), join(cliHostDst, "package.json"));
  cpSync(join(cliHostSrc, "dist"), join(cliHostDst, "dist"), { recursive: true });

  // Common assets
  if (existsSync(join(root, "agent-skills"))) {
    cpSync(join(root, "agent-skills"), join(targetDir, "agent-skills"), { recursive: true });
  }
  if (existsSync(join(root, "deploy", "docker"))) {
    cpSync(join(root, "deploy", "docker"), join(targetDir, "deploy", "docker"), { recursive: true });
  }

  // Node modules: node-pty and its dependencies
  const nmDst = join(targetDir, "node_modules");
  mkdirSync(nmDst, { recursive: true });

  const nodePtySrc = join(root, "node_modules", "node-pty");
  if (existsSync(nodePtySrc)) {
    const nodePtyDst = join(nmDst, "node-pty");
    cpSync(nodePtySrc, nodePtyDst, { recursive: true });

    // Prune prebuilds in node-pty: keep only the targeted linux architecture
    const prebuildsDir = join(nodePtyDst, "prebuilds");
    if (existsSync(prebuildsDir)) {
      const neededPrebuild = targetArch === "arm64" ? "linux-arm64" : "linux-x64";
      for (const entry of readdirSync(prebuildsDir)) {
        if (entry !== neededPrebuild) {
          rmSync(join(prebuildsDir, entry), { recursive: true, force: true });
        }
      }
    }
  }

  const addonApiSrc = join(root, "node_modules", "node-addon-api");
  if (existsSync(addonApiSrc)) {
    cpSync(addonApiSrc, join(nmDst, "node-addon-api"), { recursive: true });
  }

  // Workspace symlink: @space/cli-host
  const spaceDst = join(nmDst, "@space");
  mkdirSync(spaceDst, { recursive: true });
  cpSync(join(cliHostDst), join(spaceDst, "cli-host"), { recursive: true });

  removeSourceMaps(targetDir);
}

/**
 * Builds the standalone Browser Host container closure.
 * @param {string} root
 * @param {string} targetDir
 */
export function buildBrowserClosure(root, targetDir) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // Root files
  cpSync(join(root, "package.json"), join(targetDir, "package.json"));
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    const src = join(root, file);
    if (existsSync(src)) cpSync(src, join(targetDir, file));
  }

  // Workspace: apps/api
  const apiSrc = join(root, "apps", "api");
  const apiDst = join(targetDir, "apps", "api");
  mkdirSync(apiDst, { recursive: true });
  cpSync(join(apiSrc, "package.json"), join(apiDst, "package.json"));
  cpSync(join(apiSrc, "dist"), join(apiDst, "dist"), { recursive: true });

  // Workspaces: packages
  const browserPackages = ["browser-host", "contracts", "db", "runtime", "memory-graph"];
  for (const pkg of browserPackages) {
    const pkgSrc = join(root, "packages", pkg);
    const pkgDst = join(targetDir, "packages", pkg);
    mkdirSync(pkgDst, { recursive: true });
    cpSync(join(pkgSrc, "package.json"), join(pkgDst, "package.json"));
    if (existsSync(join(pkgSrc, "dist"))) {
      cpSync(join(pkgSrc, "dist"), join(pkgDst, "dist"), { recursive: true });
    }
    if (pkg === "db" && existsSync(join(pkgSrc, "migrations"))) {
      cpSync(join(pkgSrc, "migrations"), join(pkgDst, "migrations"), { recursive: true });
    }
  }

  // Deploy scripts
  if (existsSync(join(root, "deploy", "docker"))) {
    cpSync(join(root, "deploy", "docker"), join(targetDir, "deploy", "docker"), { recursive: true });
  }

  // Node modules: resolve minimal closure
  const nmDst = join(targetDir, "node_modules");
  mkdirSync(nmDst, { recursive: true });

  const rootDeps = [
    "pg",
    "nanoid",
    "zod",
    "graphology",
    "graphology-layout-forceatlas2",
    "mdast-util-from-markdown",
    "@t3-oss/env-core"
  ];
  const closureDeps = resolveDependencyClosure(join(root, "node_modules"), rootDeps);

  for (const dep of closureDeps) {
    const src = join(root, "node_modules", dep);
    if (existsSync(src)) {
      const dst = join(nmDst, dep);
      mkdirSync(dirname(dst), { recursive: true });
      cpSync(src, dst, { recursive: true });
    }
  }

  // Workspace packages in node_modules/@space
  const spaceDst = join(nmDst, "@space");
  mkdirSync(spaceDst, { recursive: true });
  for (const pkg of browserPackages) {
    cpSync(join(targetDir, "packages", pkg), join(spaceDst, pkg), { recursive: true });
  }

  removeSourceMaps(targetDir);
}

/**
 * Builds the core service container closure.
 * @param {string} root
 * @param {string} targetDir
 * @param {string} targetArch
 */
export function buildCoreClosure(root, targetDir, targetArch) {
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });

  // Root files
  cpSync(join(root, "package.json"), join(targetDir, "package.json"));
  for (const file of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    const src = join(root, file);
    if (existsSync(src)) cpSync(src, join(targetDir, file));
  }

  // Scripts
  const scriptsDst = join(targetDir, "scripts");
  mkdirSync(scriptsDst, { recursive: true });
  for (const script of [
    "reset-owner-password.mjs",
    "rotate-owner-setup-token.mjs",
    "portable-backup.mjs",
    "portable-restore.mjs"
  ]) {
    const src = join(root, "scripts", script);
    if (existsSync(src)) cpSync(src, join(scriptsDst, script));
  }

  // Apps: api, worker, web
  for (const app of ["api", "worker", "web"]) {
    const appSrc = join(root, "apps", app);
    if (!existsSync(appSrc)) continue;
    const appDst = join(targetDir, "apps", app);
    mkdirSync(appDst, { recursive: true });
    if (existsSync(join(appSrc, "package.json"))) {
      cpSync(join(appSrc, "package.json"), join(appDst, "package.json"));
    }
    if (existsSync(join(appSrc, "dist"))) {
      cpSync(join(appSrc, "dist"), join(appDst, "dist"), { recursive: true });
    }
    if (app === "api") {
      const pyWorker = join(appSrc, "dist", "databases", "sqlite-worker.py");
      if (!existsSync(pyWorker) && existsSync(join(appSrc, "src", "databases", "sqlite-worker.py"))) {
        mkdirSync(dirname(pyWorker), { recursive: true });
        cpSync(join(appSrc, "src", "databases", "sqlite-worker.py"), pyWorker);
      }
    }
    if (app === "web") {
      if (existsSync(join(appSrc, "server.mjs"))) {
        cpSync(join(appSrc, "server.mjs"), join(appDst, "server.mjs"));
      }
      if (existsSync(join(appSrc, "public"))) {
        cpSync(join(appSrc, "public"), join(appDst, "public"), { recursive: true });
      }
    }
  }

  // Packages: all built packages
  const packagesSrc = join(root, "packages");
  const packagesDst = join(targetDir, "packages");
  mkdirSync(packagesDst, { recursive: true });

  if (existsSync(packagesSrc)) {
    for (const pkg of readdirSync(packagesSrc)) {
      const pkgSrc = join(packagesSrc, pkg);
      if (!statSync(pkgSrc).isDirectory()) continue;
      const pkgDst = join(packagesDst, pkg);
      mkdirSync(pkgDst, { recursive: true });
      if (existsSync(join(pkgSrc, "package.json"))) {
        cpSync(join(pkgSrc, "package.json"), join(pkgDst, "package.json"));
      }
      if (existsSync(join(pkgSrc, "dist"))) {
        cpSync(join(pkgSrc, "dist"), join(pkgDst, "dist"), { recursive: true });
      }
      if (pkg === "db" && existsSync(join(pkgSrc, "migrations"))) {
        cpSync(join(pkgSrc, "migrations"), join(pkgDst, "migrations"), { recursive: true });
      }
    }
  }

  // Deploy & Assets
  if (existsSync(join(root, "agent-skills"))) {
    cpSync(join(root, "agent-skills"), join(targetDir, "agent-skills"), { recursive: true });
  }
  if (existsSync(join(root, "starter-memory"))) {
    cpSync(join(root, "starter-memory"), join(targetDir, "starter-memory"), { recursive: true });
  }
  if (existsSync(join(root, "deploy", "docker"))) {
    cpSync(join(root, "deploy", "docker"), join(targetDir, "deploy", "docker"), { recursive: true });
  }

  // Node modules: copy production modules and prune dead weight
  const nmSrc = join(root, "node_modules");
  const nmDst = join(targetDir, "node_modules");
  mkdirSync(nmDst, { recursive: true });
  cpSync(nmSrc, nmDst, { recursive: true });

  // 1. Remove node-pty from core (never runs in core)
  rmSync(join(nmDst, "node-pty"), { recursive: true, force: true });

  // 2. Remove unused typescript and types (peer dep / dev artifacts)
  rmSync(join(nmDst, "typescript"), { recursive: true, force: true });
  rmSync(join(nmDst, "@types"), { recursive: true, force: true });

  // 3. Prune @temporalio/core-bridge releases: keep only target linux architecture
  const temporalBridgeReleases = join(nmDst, "@temporalio", "core-bridge", "releases");
  if (existsSync(temporalBridgeReleases)) {
    const keepArch = targetArch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu";
    for (const entry of readdirSync(temporalBridgeReleases)) {
      if (entry !== keepArch) {
        rmSync(join(temporalBridgeReleases, entry), { recursive: true, force: true });
      }
    }
  }

  removeSourceMaps(targetDir);
}

/**
 * Runs the pruning process for all three service closures.
 */
export function pruneContainerClosures(options = parseArgs()) {
  const { targetArch, outputDir } = options;
  process.stdout.write(`Pruning container closures for target architecture: ${targetArch} into ${outputDir}\n`);

  mkdirSync(outputDir, { recursive: true });

  process.stdout.write("- Building cli closure...\n");
  buildCliClosure(repoRoot, join(outputDir, "cli"), targetArch);

  process.stdout.write("- Building browser closure...\n");
  buildBrowserClosure(repoRoot, join(outputDir, "browser"));

  process.stdout.write("- Building core closure...\n");
  buildCoreClosure(repoRoot, join(outputDir, "core"), targetArch);

  process.stdout.write("All container closures built successfully.\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    pruneContainerClosures();
  } catch (error) {
    process.stderr.write(`Error pruning container closures: ${error.message}\n`);
    process.exit(1);
  }
}
