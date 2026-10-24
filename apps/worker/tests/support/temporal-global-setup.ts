import { constants } from "node:fs";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { TestProject } from "vitest/node";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime } from "@temporalio/worker";

declare module "vitest" {
  export interface ProvidedContext { temporalTestServerPath: string; temporalBundles: Record<"current" | "legacy" | "nondeterministic", string> }
}

export default async function setup(project: TestProject) {
  Runtime.install({ logger: new DefaultLogger("ERROR") });
  // Download once, before the file workers start. /tmp can disappear on WSL
  // restart; the SDK's persistent, dedicated cache also avoids concurrent cold
  // downloads racing with each scenario's server-readiness deadline.
  const directory = join(homedir(), ".cache", "spaceapp-temporal-testing");
  await mkdir(directory, { recursive: true });
  const executable = join(directory, "temporal-test-server-sdk-typescript-1.24.0" + (process.platform === "win32" ? ".exe" : ""));
  try {
    await access(executable, constants.X_OK);
    project.provide("temporalTestServerPath", executable);
    // A cached pinned binary works offline, even after its SDK TTL.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const environment = await TestWorkflowEnvironment.createTimeSkipping({
      server: { executable: { type: "cached-download", downloadDir: directory } }
    });
    try {
      await access(executable, constants.X_OK);
      project.provide("temporalTestServerPath", executable);
    } finally { await environment.teardown(); }
  }
  // Fresh bundles belong to this invocation only: never reuse stale production code.
  // Compile each variant once instead of recompiling in every isolated test file.
  const bundlesDirectory = await mkdtemp(join(tmpdir(), "space-temporal-bundles-"));
  const paths = {} as Record<"current" | "legacy" | "nondeterministic", string>;
  try {
    for (const variant of ["current", "legacy", "nondeterministic"] as const) {
      const bundle = await bundleWorkflowCode({
        workflowsPath: fileURLToPath(new URL("./temporal-workflows.ts", import.meta.url)),
        logger: new DefaultLogger("ERROR"),
        webpackConfigHook: config => {
          if (variant !== "current") config.module!.rules!.push({
            test: /[\\/]src[\\/]workflows\.ts$/, enforce: "pre",
            use: { loader: fileURLToPath(new URL("./temporal-variant-loader.cjs", import.meta.url)), options: { variant } }
          });
          return config;
        }
      });
      paths[variant] = join(bundlesDirectory, `${variant}.js`);
      await writeFile(paths[variant], bundle.code);
    }
    project.provide("temporalBundles", paths);
  } catch (error) {
    await rm(bundlesDirectory, { recursive: true, force: true });
    throw error;
  }
  return () => rm(bundlesDirectory, { recursive: true, force: true });
}
