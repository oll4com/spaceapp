#!/usr/bin/env node
import { cp, mkdir, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(args = process.argv.slice(2)) {
  const options = { target: null, arch: "amd64", dest: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target") options.target = args[++i];
    else if (args[i] === "--arch") options.arch = args[++i];
    else if (args[i] === "--dest") options.dest = args[++i];
  }
  if (!options.target || !options.dest) {
    throw new Error(
      "Usage: prepare-container-target.mjs --target <core|browser|cli> [--arch <amd64|arm64>] --dest <path>"
    );
  }
  return options;
}

function resolveBrowserNpmDependencies() {
  const seeds = [
    "@t3-oss/env-core",
    "nanoid",
    "zod",
    "pg",
    "graphology",
    "graphology-layout-forceatlas2",
    "mdast-util-from-markdown"
  ];

  const lockPath = join(root, "package-lock.json");
  if (!existsSync(lockPath)) return seeds;

  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const packages = lock.packages || {};
  const needed = new Set();
  const queue = [...seeds];

  while (queue.length > 0) {
    const pkg = queue.shift();
    if (!pkg || needed.has(pkg)) continue;
    needed.add(pkg);

    const lockEntry = packages[`node_modules/${pkg}`];
    if (lockEntry?.dependencies) {
      for (const dep of Object.keys(lockEntry.dependencies)) {
        if (!dep.startsWith("@space/") && !needed.has(dep)) {
          queue.push(dep);
        }
      }
    }
  }

  return Array.from(needed);
}

function isPlatformPackageUnused(pkgName, arch) {
  const lower = pkgName.toLowerCase();
  const isMultiPlatform =
    lower.includes("@napi-rs/canvas-") ||
    lower.includes("@esbuild/") ||
    lower.includes("@rollup/rollup-") ||
    lower.includes("@swc/core-");

  if (!isMultiPlatform) return false;

  const nonLinux = [
    "darwin",
    "win32",
    "android",
    "freebsd",
    "musl",
    "arm-",
    "riscv64",
    "ia32",
    "s390x",
    "ppc64"
  ];

  if (nonLinux.some((plat) => lower.includes(plat))) {
    return true;
  }

  if (arch === "amd64" && (lower.includes("arm64") || lower.includes("aarch64"))) {
    return true;
  }

  if (arch === "arm64" && (lower.includes("x64") || lower.includes("x86_64"))) {
    return true;
  }

  return false;
}

async function removeSourceMaps(dir) {
  if (!existsSync(dir)) return;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await removeSourceMaps(full);
    } else if (
      entry.name.endsWith(".js.map") ||
      entry.name.endsWith(".mjs.map") ||
      entry.name.endsWith(".cjs.map") ||
      entry.name.endsWith(".css.map")
    ) {
      await rm(full, { force: true });
    }
  }
}

async function prepareCli({ dest }) {
  await mkdir(join(dest, "packages", "cli-host"), { recursive: true });
  await mkdir(join(dest, "node_modules", "@space"), { recursive: true });

  await cp(join(root, "packages", "cli-host", "package.json"), join(dest, "packages", "cli-host", "package.json"));
  if (existsSync(join(root, "packages", "cli-host", "dist"))) {
    await cp(join(root, "packages", "cli-host", "dist"), join(dest, "packages", "cli-host", "dist"), { recursive: true });
  }

  await symlink("../../packages/cli-host", join(dest, "node_modules", "@space", "cli-host"));

  await cp(join(root, "package.json"), join(dest, "package.json"));
  if (existsSync(join(root, "package-lock.json"))) {
    await cp(join(root, "package-lock.json"), join(dest, "package-lock.json"));
  }

  if (existsSync(join(root, "agent-skills"))) {
    await cp(join(root, "agent-skills"), join(dest, "agent-skills"), { recursive: true });
  }

  if (existsSync(join(root, "node_modules", "node-pty"))) {
    await cp(join(root, "node_modules", "node-pty"), join(dest, "node_modules", "node-pty"), { recursive: true });
  }
  if (existsSync(join(root, "node_modules", "node-addon-api"))) {
    await cp(join(root, "node_modules", "node-addon-api"), join(dest, "node_modules", "node-addon-api"), { recursive: true });
  }

  await removeSourceMaps(dest);
}

async function prepareBrowser({ dest }) {
  await mkdir(join(dest, "apps", "api"), { recursive: true });
  await mkdir(join(dest, "node_modules", "@space"), { recursive: true });

  await cp(join(root, "apps", "api", "package.json"), join(dest, "apps", "api", "package.json"));
  if (existsSync(join(root, "apps", "api", "dist"))) {
    await cp(join(root, "apps", "api", "dist"), join(dest, "apps", "api", "dist"), { recursive: true });
  }

  const browserPackages = [
    "browser-host",
    "contracts",
    "db",
    "runtime",
    "memory-graph"
  ];

  for (const pkg of browserPackages) {
    const pkgDir = join(dest, "packages", pkg);
    await mkdir(pkgDir, { recursive: true });
    await cp(join(root, "packages", pkg, "package.json"), join(pkgDir, "package.json"));
    if (existsSync(join(root, "packages", pkg, "dist"))) {
      await cp(join(root, "packages", pkg, "dist"), join(pkgDir, "dist"), { recursive: true });
    }
    await symlink(`../../packages/${pkg}`, join(dest, "node_modules", "@space", pkg));
  }
  await symlink("../../apps/api", join(dest, "node_modules", "@space", "api"));

  await cp(join(root, "package.json"), join(dest, "package.json"));
  if (existsSync(join(root, "package-lock.json"))) {
    await cp(join(root, "package-lock.json"), join(dest, "package-lock.json"));
  }

  const npmDeps = resolveBrowserNpmDependencies();
  for (const dep of npmDeps) {
    const srcPath = join(root, "node_modules", dep);
    const destPath = join(dest, "node_modules", dep);
    if (existsSync(srcPath)) {
      await mkdir(dirname(destPath), { recursive: true });
      await cp(srcPath, destPath, { recursive: true });
    }
  }

  await removeSourceMaps(dest);
}

async function prepareCore({ dest, arch }) {
  await mkdir(dest, { recursive: true });

  await cp(join(root, "package.json"), join(dest, "package.json"));
  if (existsSync(join(root, "package-lock.json"))) {
    await cp(join(root, "package-lock.json"), join(dest, "package-lock.json"));
  }

  // Copy apps
  await cp(join(root, "apps"), join(dest, "apps"), { recursive: true });

  // Copy packages except run-spaceapp (cli-host client runtime is required by apps/api)
  await mkdir(join(dest, "packages"), { recursive: true });
  const packageEntries = await readdir(join(root, "packages"), { withFileTypes: true });
  for (const entry of packageEntries) {
    if (entry.isDirectory() && entry.name !== "run-spaceapp") {
      await cp(join(root, "packages", entry.name), join(dest, "packages", entry.name), { recursive: true });
    }
  }

  // Copy runtime maintenance scripts
  await mkdir(join(dest, "scripts"), { recursive: true });
  for (const scriptName of [
    "reset-owner-password.mjs",
    "rotate-owner-setup-token.mjs",
    "portable-backup.mjs",
    "portable-restore.mjs"
  ]) {
    const scriptSrc = join(root, "scripts", scriptName);
    if (existsSync(scriptSrc)) {
      await cp(scriptSrc, join(dest, "scripts", scriptName));
    }
  }

  // Copy node_modules, omitting node-pty and unused multiplatform prebuilds
  if (existsSync(join(root, "node_modules"))) {
    await mkdir(join(dest, "node_modules"), { recursive: true });
    const nmEntries = await readdir(join(root, "node_modules"), { withFileTypes: true });
    for (const entry of nmEntries) {
      if (entry.name === "node-pty") continue;

      if (entry.name.startsWith("@")) {
        const scopeSrc = join(root, "node_modules", entry.name);
        const scopeEntries = await readdir(scopeSrc, { withFileTypes: true });
        for (const sub of scopeEntries) {
          const fullName = `${entry.name}/${sub.name}`;
          if (isPlatformPackageUnused(fullName, arch)) continue;

          const subSrc = join(scopeSrc, sub.name);
          const subDest = join(dest, "node_modules", entry.name, sub.name);
          await mkdir(dirname(subDest), { recursive: true });
          await cp(subSrc, subDest, { recursive: true });
        }
      } else {
        if (isPlatformPackageUnused(entry.name, arch)) continue;

        const modSrc = join(root, "node_modules", entry.name);
        const modDest = join(dest, "node_modules", entry.name);
        await cp(modSrc, modDest, { recursive: true });
      }
    }
  }

  await removeSourceMaps(dest);
}

export async function prepareContainerTarget(args = process.argv.slice(2)) {
  const { target, arch, dest } = parseArgs(args);
  await rm(dest, { recursive: true, force: true });

  if (target === "cli") {
    await prepareCli({ dest });
  } else if (target === "browser") {
    await prepareBrowser({ dest });
  } else if (target === "core") {
    await prepareCore({ dest, arch });
  } else {
    throw new Error(`Unknown target: ${target}`);
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  prepareContainerTarget().catch((err) => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
