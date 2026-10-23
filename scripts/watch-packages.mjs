#!/usr/bin/env node
import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, "packages");

/**
 * Rebuilds all workspace packages via npm run build:packages.
 *
 * @returns {Promise<number>} Exit code of the build process.
 */
export function rebuildPackages() {
  return new Promise((resolve) => {
    console.log(`\n[watch:packages] Package file change detected. Rebuilding packages...`);
    let settled = false;
    const proc = spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:packages"], {
      cwd: ROOT,
      stdio: "inherit"
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      console.error("[watch:packages] Spawn error:", err.message);
      resolve(1);
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) {
        console.log(`[watch:packages] Packages rebuilt successfully.\n`);
      } else {
        console.error(`[watch:packages] Package build failed with code ${code}.\n`);
      }
      resolve(code ?? 1);
    });
  });
}

/**
 * Starts watching packages/ directory and triggers debounced package rebuilding.
 */
export function startPackageWatcher() {
  console.log(`Watching for changes across packages/*...`);
  let debounceTimeout = null;
  let isBuilding = false;
  let rebuildPending = false;

  const watcher = watch(PACKAGES_DIR, { recursive: true }, (_eventType, filename) => {
    if (!filename) return;
    const normalized = filename.replaceAll("\\", "/");
    if (
      normalized.includes("/dist/") ||
      normalized.includes("/node_modules/") ||
      normalized.includes("/tests/") ||
      normalized.startsWith(".") ||
      (!normalized.endsWith(".ts") && !normalized.endsWith(".tsx") && !normalized.endsWith(".sql") && !normalized.endsWith(".js") && !normalized.endsWith(".mjs"))
    ) {
      return;
    }

    if (debounceTimeout) clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(async () => {
      if (isBuilding) {
        rebuildPending = true;
        return;
      }
      isBuilding = true;
      try {
        do {
          rebuildPending = false;
          await rebuildPackages();
        } while (rebuildPending);
      } finally {
        isBuilding = false;
      }
    }, 400);
  });

  return watcher;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  startPackageWatcher();
}
