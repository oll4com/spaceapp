// Module resolution hooks for worktree-source-loader.mjs (see there).
import { appendFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let resolveLog = null;

export function initialize(data) {
  resolveLog = data?.resolveLog ?? null;
}

/** Appends one redirected import to the evidence log, when one is configured. */
export function noteResolution(log, specifier, url) {
  if (!log) return;
  try { appendFileSync(log, `${JSON.stringify({ specifier, url })}\n`); } catch { /* evidence only */ }
}

/** packages/<name>/src/index.ts of this checkout for "@space/<name>", or null. */
export function workspaceSource(specifier) {
  const match = /^@space\/([a-z0-9-]+)$/.exec(specifier);
  if (!match) return null;
  const source = path.join(repoRoot, "packages", match[1], "src", "index.ts");
  return existsSync(source) ? source : null;
}

export async function resolve(specifier, context, nextResolve) {
  const source = workspaceSource(specifier);
  if (source) {
    const url = pathToFileURL(source).href;
    noteResolution(resolveLog, specifier, url);
    return { url, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
