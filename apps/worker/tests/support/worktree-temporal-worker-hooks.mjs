// Resolution hook for worktree-temporal-worker-loader.mjs (see there).
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { noteResolution, repoRoot } from "../../../../scripts/test-support/worktree-source-hooks.mjs";

const workerEntry = pathToFileURL(path.join(repoRoot, "apps/worker/src/worker.ts")).href;
const temporalWorkerShim = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "worktree-temporal-worker.mjs")).href;
let resolveLog = null;

export function initialize(data) {
  resolveLog = data?.resolveLog ?? null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@temporalio/worker" && context.parentURL === workerEntry) {
    noteResolution(resolveLog, specifier, temporalWorkerShim);
    return { url: temporalWorkerShim, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
