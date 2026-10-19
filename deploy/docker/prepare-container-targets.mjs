#!/usr/bin/env node
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = resolve(dirname(__filename), "../..");

function parseArgs(args = process.argv.slice(2)) {
  let arch = process.arch === "arm64" ? "arm64" : "amd64";
  let outputDir = "/app-targets";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--arch" && args[i + 1]) {
      arch = args[i + 1].replace(/^linux\//, "");
      i++;
    } else if (args[i] === "--output" && args[i + 1]) {
      outputDir = resolve(args[i + 1]);
      i++;
    }
  }
  return { arch, outputDir };
}

function safeSymlink(target, linkPath, fallbackSrcDir = null) {
  try {
    symlinkSync(target, linkPath);
  } catch (err) {
    if (process.platform === "win32") {
      try {
        symlinkSync(target, linkPath, "junction");
      } catch {
        if (fallbackSrcDir && existsSync(fallbackSrcDir)) {
          cpSync(fallbackSrcDir, linkPath, { recursive: true });
        }
      }
    } else {
      throw err;
    }
  }
}

function copyEntry(src, dest, filterFn) {
  if (!existsSync(src)) return;
  const stat = lstatSync(src);
  if (stat.isSymbolicLink()) {
    // Preserve symlink as is or skip if filter says so
    return;
  }
  if (stat.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const name of readdirSync(src)) {
      const srcChild = join(src, name);
      const destChild = join(dest, name);
      if (filterFn && !filterFn(srcChild, name)) continue;
      copyEntry(srcChild, destChild, filterFn);
    }
  } else {
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(src, dest);
  }
}

function pruneDevArtifacts(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "test" ||
        entry.name === "tests" ||
        entry.name === "__tests__" ||
        entry.name === ".github" ||
        entry.name === "docs" ||
        entry.name === "example" ||
        entry.name === "examples"
      ) {
        rmSync(fullPath, { recursive: true, force: true });
      } else {
        pruneDevArtifacts(fullPath);
      }
    } else if (
      entry.name.endsWith(".d.ts") ||
      entry.name.endsWith(".d.mts") ||
      entry.name.endsWith(".d.cts") ||
      entry.name.endsWith(".map") ||
      entry.name.endsWith(".markdown") ||
      (entry.name.startsWith("README") && !entry.name.includes("BUSL")) ||
      entry.name.startsWith("CHANGELOG")
    ) {
      rmSync(fullPath, { force: true });
    }
  }
}

export function prepareContainerTargets({ sourceDir = rootDir, outputDir = "/app-targets", arch = "amd64" } = {}) {
  const normArch = arch === "arm64" ? "arm64" : "amd64";
  const cliTarget = join(outputDir, "cli");
  const browserTarget = join(outputDir, "browser");
  const coreTarget = join(outputDir, "core");

  rmSync(cliTarget, { recursive: true, force: true });
  rmSync(browserTarget, { recursive: true, force: true });
  rmSync(coreTarget, { recursive: true, force: true });

  mkdirSync(cliTarget, { recursive: true });
  mkdirSync(browserTarget, { recursive: true });
  mkdirSync(coreTarget, { recursive: true });

  const rootPkg = join(sourceDir, "package.json");
  const rootPkgLock = join(sourceDir, "package-lock.json");

  // ==========================================
  // 1. Prepare CLI target
  // ==========================================
  cpSync(rootPkg, join(cliTarget, "package.json"));
  if (existsSync(rootPkgLock)) cpSync(rootPkgLock, join(cliTarget, "package-lock.json"));

  // CLI host package
  const cliHostSrc = join(sourceDir, "packages/cli-host");
  const cliHostDest = join(cliTarget, "packages/cli-host");
  mkdirSync(join(cliHostDest, "dist"), { recursive: true });
  cpSync(join(cliHostSrc, "package.json"), join(cliHostDest, "package.json"));
  cpSync(join(cliHostSrc, "dist"), join(cliHostDest, "dist"), { recursive: true });
  if (existsSync(join(cliHostSrc, "node_modules"))) {
    cpSync(join(cliHostSrc, "node_modules"), join(cliHostDest, "node_modules"), { recursive: true });
  }

  // Agent skills
  if (existsSync(join(sourceDir, "agent-skills"))) {
    cpSync(join(sourceDir, "agent-skills"), join(cliTarget, "agent-skills"), { recursive: true });
  }
  // Deploy docker scripts
  if (existsSync(join(sourceDir, "deploy/docker"))) {
    cpSync(join(sourceDir, "deploy/docker"), join(cliTarget, "deploy/docker"), { recursive: true });
  }

  // CLI node_modules: only node-pty and @space/cli-host
  const cliNm = join(cliTarget, "node_modules");
  mkdirSync(cliNm, { recursive: true });
  const nodePtySrc = join(sourceDir, "node_modules/node-pty");
  if (existsSync(nodePtySrc)) {
    cpSync(nodePtySrc, join(cliNm, "node-pty"), { recursive: true });
  }
  const cliSpace = join(cliNm, "@space");
  mkdirSync(cliSpace, { recursive: true });
  safeSymlink("../../packages/cli-host", join(cliSpace, "cli-host"), cliHostDest);

  // ==========================================
  // 2. Prepare Browser target
  // ==========================================
  cpSync(rootPkg, join(browserTarget, "package.json"));
  if (existsSync(rootPkgLock)) cpSync(rootPkgLock, join(browserTarget, "package-lock.json"));

  // Apps API for browser-host-main
  const apiSrc = join(sourceDir, "apps/api");
  const apiDest = join(browserTarget, "apps/api");
  mkdirSync(join(apiDest, "dist"), { recursive: true });
  cpSync(join(apiSrc, "package.json"), join(apiDest, "package.json"));
  if (existsSync(join(apiSrc, "dist"))) {
    cpSync(join(apiSrc, "dist"), join(apiDest, "dist"), { recursive: true });
  }
  if (existsSync(join(apiSrc, "node_modules"))) {
    cpSync(join(apiSrc, "node_modules"), join(apiDest, "node_modules"), { recursive: true });
  }

  // Packages needed by browser host
  const browserPackages = [
    "browser-host",
    "contracts",
    "db",
    "runtime",
    "memory-graph",
    "streaming",
    "icons",
    "opencode-control",
    "codex-app-server"
  ];
  for (const pkg of browserPackages) {
    const pkgSrc = join(sourceDir, "packages", pkg);
    if (!existsSync(pkgSrc)) continue;
    const pkgDest = join(browserTarget, "packages", pkg);
    mkdirSync(join(pkgDest, "dist"), { recursive: true });
    cpSync(join(pkgSrc, "package.json"), join(pkgDest, "package.json"));
    if (existsSync(join(pkgSrc, "dist"))) {
      cpSync(join(pkgSrc, "dist"), join(pkgDest, "dist"), { recursive: true });
    }
    if (pkg === "db" && existsSync(join(pkgSrc, "migrations"))) {
      cpSync(join(pkgSrc, "migrations"), join(pkgDest, "migrations"), { recursive: true });
    }
    if (existsSync(join(pkgSrc, "node_modules"))) {
      cpSync(join(pkgSrc, "node_modules"), join(pkgDest, "node_modules"), { recursive: true });
    }
  }

  if (existsSync(join(sourceDir, "deploy/docker"))) {
    cpSync(join(sourceDir, "deploy/docker"), join(browserTarget, "deploy/docker"), { recursive: true });
  }

  // Browser node_modules: copy all except heavy unused deps
  const excludedFromBrowser = new Set([
    "@temporalio",
    "pdfjs-dist",
    "@napi-rs",
    "node-pty",
    "lucide-react",
    "typescript",
    "webpack",
    "react",
    "react-dom",
    "@swc",
    "@esbuild"
  ]);

  const browserNm = join(browserTarget, "node_modules");
  mkdirSync(browserNm, { recursive: true });

  for (const name of readdirSync(join(sourceDir, "node_modules"))) {
    if (name === ".bin" || name === ".package-lock.json") continue;
    if (name === "@space") continue; // Re-symlink below
    if (excludedFromBrowser.has(name)) continue;
    const modSrc = join(sourceDir, "node_modules", name);
    if (lstatSync(modSrc).isSymbolicLink()) continue;
    const modDest = join(browserNm, name);
    if (name.startsWith("@")) {
      mkdirSync(modDest, { recursive: true });
      for (const sub of readdirSync(modSrc)) {
        if (excludedFromBrowser.has(`${name}/${sub}`)) continue;
        cpSync(join(modSrc, sub), join(modDest, sub), { recursive: true });
      }
    } else {
      cpSync(modSrc, modDest, { recursive: true });
    }
  }

  // Create @space symlinks for browser packages
  const browserSpace = join(browserNm, "@space");
  mkdirSync(browserSpace, { recursive: true });
  for (const pkg of browserPackages) {
    safeSymlink(`../../packages/${pkg}`, join(browserSpace, pkg), join(browserTarget, "packages", pkg));
  }
  safeSymlink("../../apps/api", join(browserSpace, "api"), apiDest);

  pruneDevArtifacts(browserNm);

  // ==========================================
  // 3. Prepare Core target
  // ==========================================
  cpSync(rootPkg, join(coreTarget, "package.json"));
  if (existsSync(rootPkgLock)) cpSync(rootPkgLock, join(coreTarget, "package-lock.json"));

  // Copy apps
  for (const app of ["api", "worker", "web"]) {
    const appSrc = join(sourceDir, "apps", app);
    const appDest = join(coreTarget, "apps", app);
    mkdirSync(appDest, { recursive: true });
    cpSync(join(appSrc, "package.json"), join(appDest, "package.json"));
    if (existsSync(join(appSrc, "dist"))) {
      cpSync(join(appSrc, "dist"), join(appDest, "dist"), { recursive: true });
    }
    if (existsSync(join(appSrc, "node_modules"))) {
      cpSync(join(appSrc, "node_modules"), join(appDest, "node_modules"), { recursive: true });
    }
    if (app === "api") {
      const dbPy = join(appSrc, "dist/databases/sqlite-worker.py");
      const dbPySrc = join(appSrc, "src/databases/sqlite-worker.py");
      if (existsSync(dbPySrc) && !existsSync(dbPy)) {
        mkdirSync(dirname(dbPy), { recursive: true });
        cpSync(dbPySrc, dbPy);
      }
    }
    if (app === "web") {
      if (existsSync(join(appSrc, "server.mjs"))) cpSync(join(appSrc, "server.mjs"), join(appDest, "server.mjs"));
      if (existsSync(join(appSrc, "server-routing.mjs"))) cpSync(join(appSrc, "server-routing.mjs"), join(appDest, "server-routing.mjs"));
      if (existsSync(join(appSrc, "public"))) cpSync(join(appSrc, "public"), join(appDest, "public"), { recursive: true });
    }
  }

  // Copy all packages
  for (const pkg of readdirSync(join(sourceDir, "packages"))) {
    const pkgSrc = join(sourceDir, "packages", pkg);
    if (!lstatSync(pkgSrc).isDirectory()) continue;
    const pkgDest = join(coreTarget, "packages", pkg);
    mkdirSync(pkgDest, { recursive: true });
    if (existsSync(join(pkgSrc, "package.json"))) {
      cpSync(join(pkgSrc, "package.json"), join(pkgDest, "package.json"));
    }
    if (existsSync(join(pkgSrc, "dist"))) {
      cpSync(join(pkgSrc, "dist"), join(pkgDest, "dist"), { recursive: true });
    }
    if (pkg === "db" && existsSync(join(pkgSrc, "migrations"))) {
      cpSync(join(pkgSrc, "migrations"), join(pkgDest, "migrations"), { recursive: true });
    }
    if (existsSync(join(pkgSrc, "node_modules"))) {
      cpSync(join(pkgSrc, "node_modules"), join(pkgDest, "node_modules"), { recursive: true });
    }
  }

  // Deploy docker scripts
  if (existsSync(join(sourceDir, "deploy/docker"))) {
    cpSync(join(sourceDir, "deploy/docker"), join(coreTarget, "deploy/docker"), { recursive: true });
  }

  // Core node_modules: copy all except node-pty and typescript
  const coreNm = join(coreTarget, "node_modules");
  mkdirSync(coreNm, { recursive: true });

  for (const name of readdirSync(join(sourceDir, "node_modules"))) {
    if (name === ".bin" || name === ".package-lock.json") continue;
    if (name === "@space") continue;
    if (name === "node-pty" || name === "typescript") continue;
    const modSrc = join(sourceDir, "node_modules", name);
    if (lstatSync(modSrc).isSymbolicLink()) continue;
    const modDest = join(coreNm, name);
    cpSync(modSrc, modDest, { recursive: true });
  }

  // Re-link all @space packages in core
  const coreSpace = join(coreNm, "@space");
  mkdirSync(coreSpace, { recursive: true });
  for (const pkg of readdirSync(join(sourceDir, "packages"))) {
    if (lstatSync(join(sourceDir, "packages", pkg)).isDirectory()) {
      safeSymlink(`../../packages/${pkg}`, join(coreSpace, pkg), join(coreTarget, "packages", pkg));
    }
  }
  for (const app of ["api", "worker", "web"]) {
    safeSymlink(`../../apps/${app}`, join(coreSpace, app), join(coreTarget, "apps", app));
  }

  // Prune unused architectures from @temporalio/core-bridge/releases
  const releasesDir = join(coreNm, "@temporalio/core-bridge/releases");
  if (existsSync(releasesDir)) {
    // Non-linux platforms always deleted
    rmSync(join(releasesDir, "aarch64-apple-darwin"), { recursive: true, force: true });
    rmSync(join(releasesDir, "x86_64-apple-darwin"), { recursive: true, force: true });
    rmSync(join(releasesDir, "x86_64-pc-windows-msvc"), { recursive: true, force: true });

    if (normArch === "amd64") {
      rmSync(join(releasesDir, "aarch64-unknown-linux-gnu"), { recursive: true, force: true });
    } else if (normArch === "arm64") {
      rmSync(join(releasesDir, "x86_64-unknown-linux-gnu"), { recursive: true, force: true });
    }
  }

  // Prune any non-linux prebuilds in @napi-rs
  const napiDir = join(coreNm, "@napi-rs");
  if (existsSync(napiDir)) {
    for (const sub of readdirSync(napiDir)) {
      if (sub.includes("win32") || sub.includes("darwin")) {
        rmSync(join(napiDir, sub), { recursive: true, force: true });
      }
    }
  }

  pruneDevArtifacts(coreNm);
}

if (process.argv[1] === __filename) {
  const { arch, outputDir } = parseArgs();
  process.stdout.write(`Staging container targets for linux/${arch} into ${outputDir}...\n`);
  prepareContainerTargets({ outputDir, arch });
  process.stdout.write("Container targets staged successfully.\n");
}
