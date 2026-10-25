// @temporalio/worker as seen by apps/worker/src/worker.ts under
// worktree-temporal-worker-loader.mjs. Worker.create receives exactly the
// options the worker passes, with two source-tree adjustments for the workflow
// bundle only:
// - workflowsPath "./workflows.js" names the TypeScript source when no build exists;
// - @space/* imports inside the bundle resolve to packages/<name>/src of this checkout.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import * as temporalWorker from "@temporalio/worker";
import { repoRoot } from "../../../../scripts/test-support/worktree-source-hooks.mjs";

export const { NativeConnection, Runtime, bundleWorkflowCode } = temporalWorker;

function workspaceAliases() {
  const aliases = {};
  for (const name of readdirSync(path.join(repoRoot, "packages"))) {
    const source = path.join(repoRoot, "packages", name, "src", "index.ts");
    if (existsSync(source)) aliases[`@space/${name}$`] = source;
  }
  return aliases;
}

export const Worker = {
  async create(options) {
    let workflowsPath = options.workflowsPath;
    if (workflowsPath?.endsWith(".js") && !existsSync(workflowsPath)) workflowsPath = workflowsPath.replace(/\.js$/, ".ts");
    const outerHook = options.bundlerOptions?.webpackConfigHook;
    return temporalWorker.Worker.create({
      ...options,
      workflowsPath,
      bundlerOptions: {
        ...options.bundlerOptions,
        webpackConfigHook: (config) => {
          const next = outerHook ? outerHook(config) : config;
          return { ...next, resolve: { ...next.resolve, alias: { ...next.resolve?.alias, ...workspaceAliases() } } };
        }
      }
    });
  }
};
