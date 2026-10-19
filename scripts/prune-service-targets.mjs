#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(args) {
  let targetArch = process.arch === "arm64" ? "arm64" : "amd64";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target-arch" && args[i + 1]) {
      targetArch = args[i + 1];
      i++;
    } else if (args[i].startsWith("--target-arch=")) {
      targetArch = args[i].slice("--target-arch=".length);
    }
  }
  return { targetArch };
}

function removeMaps(dir) {
  if (!existsSync(dir)) return;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      removeMaps(fullPath);
    } else if (entry.name.endsWith(".map")) {
      try { unlinkSync(fullPath); } catch {}
    }
  }
}

function safeCopy(src, dst) {
  if (!existsSync(src)) return;
  const parent = dirname(dst);
  mkdirSync(parent, { recursive: true });
  cpSync(src, dst, { recursive: true, dereference: false });
}

export function pruneServiceTargets({ targetArch = "amd64" } = {}) {
  const isAmd64 = targetArch === "amd64";
  const isArm64 = targetArch === "arm64";
  const targetsRoot = join(root, "targets");

  // Clean targets directory
  rmSync(targetsRoot, { recursive: true, force: true });
  mkdirSync(targetsRoot, { recursive: true });

  const coreRoot = join(targetsRoot, "core");
  const browserRoot = join(targetsRoot, "browser");
  const cliRoot = join(targetsRoot, "cli");

  for (const dir of [coreRoot, browserRoot, cliRoot]) {
    mkdirSync(dir, { recursive: true });
  }

  // Common metadata files
  for (const file of ["package.json", "package-lock.json", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) {
    for (const targetDir of [coreRoot, browserRoot, cliRoot]) {
      safeCopy(join(root, file), join(targetDir, file));
    }
  }

  // ---------------------------------------------------------------------------
  // 1. CLI target
  // ---------------------------------------------------------------------------
  safeCopy(join(root, "packages/cli-host"), join(cliRoot, "packages/cli-host"));
  safeCopy(join(root, "agent-skills"), join(cliRoot, "agent-skills"));
  // CLI only needs node-pty and its dependency node-addon-api
  if (existsSync(join(root, "node_modules/node-pty"))) {
    safeCopy(join(root, "node_modules/node-pty"), join(cliRoot, "node_modules/node-pty"));
  }
  if (existsSync(join(root, "node_modules/node-addon-api"))) {
    safeCopy(join(root, "node_modules/node-addon-api"), join(cliRoot, "node_modules/node-addon-api"));
  }
  removeMaps(cliRoot);

  // ---------------------------------------------------------------------------
  // 2. Browser target
  // ---------------------------------------------------------------------------
  safeCopy(join(root, "apps/api/dist"), join(browserRoot, "apps/api/dist"));
  safeCopy(join(root, "apps/api/package.json"), join(browserRoot, "apps/api/package.json"));
  for (const pkg of ["browser-host", "contracts", "db", "runtime", "icons"]) {
    safeCopy(join(root, `packages/${pkg}`), join(browserRoot, `packages/${pkg}`));
  }

  // Copy node_modules excluding heavy unneeded subsystems
  const browserExcludedModules = new Set([
    "@temporalio",
    "@napi-rs",
    "pdfjs-dist",
    "node-pty",
    "node-addon-api",
    "@uiw",
    "@codemirror",
    "@formkit",
    "@novnc",
    "@tanstack",
    "cube-motion",
    "graphology",
    "motion",
    "react-markdown",
    "remark-gfm",
    "sigma",
    "esbuild",
    "rollup"
  ]);

  if (existsSync(join(root, "node_modules"))) {
    const modules = readdirSync(join(root, "node_modules"), { withFileTypes: true });
    for (const mod of modules) {
      if (browserExcludedModules.has(mod.name)) continue;
      safeCopy(join(root, "node_modules", mod.name), join(browserRoot, "node_modules", mod.name));
    }
  }
  removeMaps(browserRoot);

  // ---------------------------------------------------------------------------
  // 3. Core target
  // ---------------------------------------------------------------------------
  safeCopy(join(root, "apps/api"), join(coreRoot, "apps/api"));
  safeCopy(join(root, "apps/worker"), join(coreRoot, "apps/worker"));
  safeCopy(join(root, "apps/web"), join(coreRoot, "apps/web"));

  safeCopy(join(root, "agent-skills"), join(coreRoot, "agent-skills"));

  // Core packages (packages/cli-host is included for workspace links and client, node-pty remains excluded)
  for (const pkg of [
    "browser-host", "contracts", "db", "gateway", "icons",
    "memory-graph", "opencode-control", "runtime", "streaming", "codex-app-server", "cli-host"
  ]) {
    safeCopy(join(root, `packages/${pkg}`), join(coreRoot, `packages/${pkg}`));
  }

  // Copy node_modules excluding node-pty (cli-only)
  if (existsSync(join(root, "node_modules"))) {
    const modules = readdirSync(join(root, "node_modules"), { withFileTypes: true });
    for (const mod of modules) {
      if (mod.name === "node-pty" || mod.name === "node-addon-api") continue;
      safeCopy(join(root, "node_modules", mod.name), join(coreRoot, "node_modules", mod.name));
    }
  }

  // Clean unneeded platform prebuilds in core
  // (A) @napi-rs/canvas foreign architectures
  const canvasPath = join(coreRoot, "node_modules/@napi-rs");
  if (existsSync(canvasPath)) {
    const canvasEntries = readdirSync(canvasPath, { withFileTypes: true });
    for (const entry of canvasEntries) {
      if (!entry.name.startsWith("canvas-")) continue;
      if (isAmd64 && entry.name === "canvas-linux-x64-gnu") continue;
      if (isArm64 && entry.name === "canvas-linux-arm64-gnu") continue;
      // Foreign architecture: remove
      rmSync(join(canvasPath, entry.name), { recursive: true, force: true });
    }
  }

  // (B) @temporalio/core-bridge foreign platform binaries
  const temporalReleases = join(coreRoot, "node_modules/@temporalio/core-bridge/releases");
  if (existsSync(temporalReleases)) {
    const bridgeFiles = readdirSync(temporalReleases, { withFileTypes: true });
    for (const file of bridgeFiles) {
      if (isAmd64 && file.name.includes("x86_64-unknown-linux-gnu")) continue;
      if (isArm64 && file.name.includes("aarch64-unknown-linux-gnu")) continue;
      rmSync(join(temporalReleases, file.name), { recursive: true, force: true });
    }
  }

  // Remove source files that are only needed at build time from copied apps
  for (const app of ["apps/api", "apps/worker", "apps/web"]) {
    rmSync(join(coreRoot, app, "src"), { recursive: true, force: true });
  }

  removeMaps(coreRoot);

  console.log(`[prune-service-targets] Successfully prepared per-service deployment targets for linux/${targetArch}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { targetArch } = parseArgs(process.argv.slice(2));
  pruneServiceTargets({ targetArch });
}
