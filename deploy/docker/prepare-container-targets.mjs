#!/usr/bin/env node
/**
 * Staging script for per-service container image dependency closures.
 * Prepares isolated file trees for core, browser, and cli targets in /app/targets/<target>.
 */

import { cpSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "../..");
const targetsDir = join(repoRoot, "targets");

const TARGETS = ["core", "browser", "cli"];

/**
 * Ensures that a target directory exists and is empty.
 * @param {string} dir - Directory path to initialize.
 * @returns {void}
 */
function ensureEmptyDir(dir) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(dir, { recursive: true });
}

/**
 * Copies a source file or directory tree to destination if source exists.
 * @param {string} src - Source file or directory path.
 * @param {string} dest - Destination file or directory path.
 * @returns {void}
 */
function safeCopy(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, dereference: false });
}

/**
 * Removes a file or directory tree recursively if it exists.
 * @param {string} path - Path to delete.
 * @returns {void}
 */
function safeRemove(path) {
  if (!existsSync(path)) return;
  rmSync(path, { recursive: true, force: true });
}

/**
 * Prunes native binaries and prebuilds targeting non-Linux or musl platforms from node_modules.
 * @param {string} nodeModulesDir - Path to node_modules directory.
 * @returns {void}
 */
function removeUnusedPlatformBinaries(nodeModulesDir) {
  // Prune prebuilds for other OSes from node-pty
  const nodePtyPrebuilds = join(nodeModulesDir, "node-pty/prebuilds");
  if (existsSync(nodePtyPrebuilds)) {
    for (const name of ["darwin-arm64", "darwin-x64", "win32-arm64", "win32-x64"]) {
      safeRemove(join(nodePtyPrebuilds, name));
    }
  }

  // Prune Darwin and Windows binaries from @temporalio/core-bridge
  const temporalReleases = join(nodeModulesDir, "@temporalio/core-bridge/releases");
  if (existsSync(temporalReleases)) {
    for (const name of ["aarch64-apple-darwin", "x86_64-apple-darwin", "x86_64-pc-windows-msvc"]) {
      safeRemove(join(temporalReleases, name));
    }
  }

  // Prune musl and non-linux binaries from @napi-rs and @swc
  const napiDir = join(nodeModulesDir, "@napi-rs");
  if (existsSync(napiDir)) {
    for (const sub of readdirSync(napiDir)) {
      if (sub.includes("musl") || sub.includes("win32") || sub.includes("darwin") || sub.includes("android")) {
        safeRemove(join(napiDir, sub));
      }
    }
  }

  const swcDir = join(nodeModulesDir, "@swc");
  if (existsSync(swcDir)) {
    for (const sub of readdirSync(swcDir)) {
      if (sub.includes("musl") || sub.includes("win32") || sub.includes("darwin") || sub.includes("android")) {
        safeRemove(join(swcDir, sub));
      }
    }
  }
}

/**
 * Prepares isolated production filesystem targets for core, browser, and cli service images.
 * @returns {void}
 */
export function prepareTargets() {
  process.stdout.write("Staging per-service container closures in /app/targets...\n");

  for (const target of TARGETS) {
    const dest = join(targetsDir, target);
    ensureEmptyDir(dest);

    // Common root files
    safeCopy(join(repoRoot, "package.json"), join(dest, "package.json"));
    safeCopy(join(repoRoot, "package-lock.json"), join(dest, "package-lock.json"));

    // Copy production node_modules
    const nodeModulesDest = join(dest, "node_modules");
    safeCopy(join(repoRoot, "node_modules"), nodeModulesDest);

    // Prune cross-platform native dead-weight from all Linux targets
    removeUnusedPlatformBinaries(nodeModulesDest);

    if (target === "core") {
      // Core services: api, worker, web
      safeCopy(join(repoRoot, "apps/api/dist"), join(dest, "apps/api/dist"));
      safeCopy(join(repoRoot, "apps/api/package.json"), join(dest, "apps/api/package.json"));

      safeCopy(join(repoRoot, "apps/worker/dist"), join(dest, "apps/worker/dist"));
      safeCopy(join(repoRoot, "apps/worker/package.json"), join(dest, "apps/worker/package.json"));

      safeCopy(join(repoRoot, "apps/web/dist"), join(dest, "apps/web/dist"));
      safeCopy(join(repoRoot, "apps/web/server.mjs"), join(dest, "apps/web/server.mjs"));
      safeCopy(join(repoRoot, "apps/web/package.json"), join(dest, "apps/web/package.json"));

      // Workspaces needed by API and Worker
      const corePackages = [
        "contracts",
        "cli-host",
        "icons",
        "streaming",
        "opencode-control",
        "memory-graph",
        "browser-host",
        "codex-app-server",
        "runtime",
        "db",
        "gateway"
      ];
      for (const pkg of corePackages) {
        safeCopy(join(repoRoot, `packages/${pkg}/dist`), join(dest, `packages/${pkg}/dist`));
        safeCopy(join(repoRoot, `packages/${pkg}/package.json`), join(dest, `packages/${pkg}/package.json`));
      }

      // Root maintenance scripts
      for (const script of [
        "reset-owner-password.mjs",
        "rotate-owner-setup-token.mjs",
        "portable-backup.mjs",
        "portable-restore.mjs"
      ]) {
        safeCopy(join(repoRoot, `scripts/${script}`), join(dest, `scripts/${script}`));
      }

      // Preserve browser-host-main.js exclusion (runs exclusively in browser-host image)
      safeRemove(join(dest, "apps/api/dist/browser-host-main.js"));

    } else if (target === "browser") {
      // Browser Host service only
      safeCopy(join(repoRoot, "apps/api/dist"), join(dest, "apps/api/dist"));
      safeCopy(join(repoRoot, "apps/api/package.json"), join(dest, "apps/api/package.json"));

      for (const pkg of ["browser-host", "contracts", "db", "runtime"]) {
        safeCopy(join(repoRoot, `packages/${pkg}/dist`), join(dest, `packages/${pkg}/dist`));
        safeCopy(join(repoRoot, `packages/${pkg}/package.json`), join(dest, `packages/${pkg}/package.json`));
      }

      // Keep only allowed workspace symlinks
      const browserAllowedSpace = new Set(["browser-host", "contracts", "db", "runtime", "api"]);
      const spaceDir = join(nodeModulesDest, "@space");
      if (existsSync(spaceDir)) {
        for (const entry of readdirSync(spaceDir)) {
          if (!browserAllowedSpace.has(entry)) {
            safeRemove(join(spaceDir, entry));
          }
        }
      }

      // Exclude heavy packages not required by Browser Host
      safeRemove(join(nodeModulesDest, "@temporalio"));
      safeRemove(join(nodeModulesDest, "pdfjs-dist"));
      safeRemove(join(nodeModulesDest, "@napi-rs"));
      safeRemove(join(nodeModulesDest, "node-pty"));
      safeRemove(join(nodeModulesDest, "@xterm"));
      safeRemove(join(nodeModulesDest, "lucide-react"));
      safeRemove(join(nodeModulesDest, "react"));
      safeRemove(join(nodeModulesDest, "react-dom"));
      safeRemove(join(nodeModulesDest, "framer-motion"));
      safeRemove(join(nodeModulesDest, "rxjs"));
      safeRemove(join(nodeModulesDest, "typescript"));
      safeRemove(join(nodeModulesDest, "webpack"));
      safeRemove(join(nodeModulesDest, "@esbuild"));

    } else if (target === "cli") {
      // CLI Host service only
      safeCopy(join(repoRoot, "packages/cli-host/dist"), join(dest, "packages/cli-host/dist"));
      safeCopy(join(repoRoot, "packages/cli-host/package.json"), join(dest, "packages/cli-host/package.json"));
      safeCopy(join(repoRoot, "packages/contracts/dist"), join(dest, "packages/contracts/dist"));
      safeCopy(join(repoRoot, "packages/contracts/package.json"), join(dest, "packages/contracts/package.json"));

      safeCopy(join(repoRoot, "agent-skills"), join(dest, "agent-skills"));

      // Keep only allowed workspace symlinks
      const cliAllowedSpace = new Set(["cli-host", "contracts"]);
      const spaceDir = join(nodeModulesDest, "@space");
      if (existsSync(spaceDir)) {
        for (const entry of readdirSync(spaceDir)) {
          if (!cliAllowedSpace.has(entry)) {
            safeRemove(join(spaceDir, entry));
          }
        }
      }

      // Exclude all heavy frontend, database, and temporal stacks
      safeRemove(join(nodeModulesDest, "@temporalio"));
      safeRemove(join(nodeModulesDest, "fastify"));
      safeRemove(join(nodeModulesDest, "@fastify"));
      safeRemove(join(nodeModulesDest, "pdfjs-dist"));
      safeRemove(join(nodeModulesDest, "@napi-rs"));
      safeRemove(join(nodeModulesDest, "lucide-react"));
      safeRemove(join(nodeModulesDest, "react"));
      safeRemove(join(nodeModulesDest, "react-dom"));
      safeRemove(join(nodeModulesDest, "framer-motion"));
      safeRemove(join(nodeModulesDest, "rxjs"));
      safeRemove(join(nodeModulesDest, "typescript"));
      safeRemove(join(nodeModulesDest, "webpack"));
      safeRemove(join(nodeModulesDest, "@esbuild"));
      safeRemove(join(nodeModulesDest, "pg"));
      safeRemove(join(nodeModulesDest, "postgres"));
      safeRemove(join(nodeModulesDest, "mysql2"));
      safeRemove(join(nodeModulesDest, "drizzle-orm"));
      safeRemove(join(nodeModulesDest, "imapflow"));
      safeRemove(join(nodeModulesDest, "mammoth"));
      safeRemove(join(nodeModulesDest, "@swc"));
    }

    process.stdout.write(`Target ${target} staged successfully in ${dest}\n`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  prepareTargets();
}
