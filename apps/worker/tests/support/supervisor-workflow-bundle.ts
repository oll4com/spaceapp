import { fileURLToPath } from "node:url";
import { bundleWorkflowCode } from "@temporalio/worker";

/** Bundle real upstream workflows; legacy changes only the patch decision. */
export function bundleSupervisorWorkflows(legacy = false) {
  const workflowsPath = fileURLToPath(new URL("../../src/workflows.ts", import.meta.url));
  return bundleWorkflowCode({
    workflowsPath,
    webpackConfigHook(config) {
      if (legacy) {
        config.module ??= {};
        config.module.rules ??= [];
        config.module.rules.push({
          test: (path: string) => path === workflowsPath,
          enforce: "pre",
          use: fileURLToPath(new URL("./supervisor-legacy-loader.cjs", import.meta.url))
        });
      }
      return config;
    }
  });
}
