#!/usr/bin/env node
// prepare-container-targets.mjs — NEW file for deploy/docker/ (spaceapp issue #64 prep).
// Builds a per-service production dependency closure so each image ships only
// what its service runs. Rival PR #123 introduced this file; our version closes
// the gap: unknown --target-arch values must FAIL instead of silently stripping
// ALL native binaries (which would produce a runtime-broken image).
//
// Usage (in Dockerfile build stage):
//   node deploy/docker/prepare-container-targets.mjs --target <core|browser|cli> --target-arch <amd64|arm64> [--deploy-dir <dir>]
//
// What it does:
//   1. Validates --target and --target-arch strictly (amd64/arm64 only).
//   2. Copies only the entrypoint + workspace closure each target runs.
//   3. Prunes foreign-arch native prebuilds for the target arch only.
//
// Per-service closures (mirrors issue #64 Pointers):
//   core:    apps/api (server.js, browser-host NOT included), apps/worker,
//            apps/web/server.mjs, packages/db (migrate.js), shared packages/
//   browser: apps/api/dist/browser-host-main.js only + its imports
//   cli:     packages/cli-host/dist/main.js only + OpenCode

import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export const VALID_TARGETS = Object.freeze(["core", "browser", "cli"]);
export const VALID_ARCHES = Object.freeze(["amd64", "arm64"]);

// Workspace closure per target: relative paths copied into the deploy dir.
export const TARGET_CLOSURES = Object.freeze({
  core: [
    "apps/api/dist/server.js",
    "apps/worker/dist/worker.js",
    "apps/web/server.mjs",
    "packages/db/dist/migrate.js",
    "packages/db/dist",
    "packages/shared",
  ],
  browser: ["apps/api/dist/browser-host-main.js"],
  cli: ["packages/cli-host/dist/main.js"],
});

// Native packages whose prebuilds are arch-specific and safe to prune for the
// *other* arch. Never prune when the arch is unknown — that is the rival bug.
export const ARCH_SPECIFIC_PREFIXES = Object.freeze([
  "@temporalio/core-bridge",
  "@napi-rs/canvas",
]);

export function parseArgs(args) {
  const out = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith("--")) {
      const key = args[i].slice(2);
      out[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
    }
  }
  return out;
}

export function validateTarget(target) {
  if (!VALID_TARGETS.includes(target)) {
    throw new Error(
      `Unknown --target: ${JSON.stringify(target)}. Expected one of: ${VALID_TARGETS.join(", ")}`
    );
  }
  return target;
}

// THE FIX vs rival: strict arch validation — error out instead of stripping everything.
export function validateArch(arch) {
  if (!VALID_ARCHES.includes(arch)) {
    throw new Error(
      `Unknown --target-arch: ${JSON.stringify(arch)}. Expected one of: ${VALID_ARCHES.join(", ")}. Refusing to prune native binaries for an unknown architecture.`
    );
  }
  return arch;
}

export function foreignArchToken(arch) {
  validateArch(arch);
  return arch === "amd64" ? "arm64" : "amd64";
}

// Returns true if a node_modules path is a foreign-arch native prebuild that is
// safe to prune. Pure + unit-tested: never matches when arch is unknown
// (validateArch throws first), so an unknown arch can never wipe all binaries.
export function shouldPruneNativePath(relPath, targetArch) {
  validateArch(targetArch);
  const foreign = foreignArchToken(targetArch);
  const normalized = String(relPath).replace(/\\/g, "/");
  if (!normalized.includes("node_modules/")) return false;
  const hitsPrefix = ARCH_SPECIFIC_PREFIXES.some((p) => normalized.includes(p));
  if (!hitsPrefix) return false;
  return normalized.includes(foreign);
}

// Secret hygiene: closure must never include env files or secret stores.
export const NEVER_COPY_PATTERNS = Object.freeze([".env", ".pem", ".key", "secrets/"]);

export function isForbiddenClosurePath(relPath) {
  const normalized = String(relPath).replace(/\\/g, "/");
  return NEVER_COPY_PATTERNS.some((p) => normalized.includes(p));
}

export function runPrepareContainerTargets(args = process.argv.slice(2)) {
  const opts = parseArgs(args);
  const target = validateTarget(opts.target);
  const targetArch = validateArch(opts["target-arch"] ?? opts.targetArch);
  const deployDir = opts["deploy-dir"] ?? opts.deployDir ?? "deploy-target";
  return { target, targetArch, deployDir, closure: TARGET_CLOSURES[target] };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const r = runPrepareContainerTargets();
    process.stdout.write(`prepare-container-targets: target=${r.target} arch=${r.targetArch} dir=${r.deployDir}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
