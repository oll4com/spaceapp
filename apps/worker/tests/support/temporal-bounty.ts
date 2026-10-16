import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, Worker, type WorkerOptions } from "@temporalio/worker";

/** The entry re-exports production workflows; it does not replace workflow APIs. */
export const bountyWorkflowsPath = fileURLToPath(new URL("../fixtures/temporal-bounty-workflows.ts", import.meta.url));

export function createBountyTestEnv(): Promise<TestWorkflowEnvironment> {
  return TestWorkflowEnvironment.createTimeSkipping();
}

let bundledWorkflows: ReturnType<typeof bundleWorkflowCode> | undefined;

export async function createBountyWorker(
  env: TestWorkflowEnvironment,
  options: Omit<WorkerOptions, "connection" | "workflowsPath">,
): Promise<Worker> {
  bundledWorkflows ??= bundleWorkflowCode({ workflowsPath: bountyWorkflowsPath });
  return Worker.create({ connection: env.nativeConnection, workflowBundle: await bundledWorkflows, ...options });
}

/** Wall-clock bound only for synchronization with an activity, never workflow timers. */
export async function eventually(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error("Activity synchronization timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
