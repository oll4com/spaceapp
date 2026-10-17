import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { ActivityFunction } from "@temporalio/common";
import { bundleWorkflowCode, DefaultLogger, Worker, type WorkflowBundle } from "@temporalio/worker";
import { MEMORY_MUTATION_TASK_QUEUE } from "@space/contracts";

let bundle: Promise<WorkflowBundle> | undefined;

export function getWorkflowBundle(): Promise<WorkflowBundle> {
  if (!bundle) {
    bundle = bundleWorkflowCode({
      workflowsPath: fileURLToPath(new URL("./workflow-sandbox-entry.ts", import.meta.url)),
      logger: new DefaultLogger("ERROR")
    });
  }
  return bundle;
}

export interface SandboxOptions {
  activities: Record<string, ActivityFunction>;
  legacySupervisor?: boolean;
  /** The production consolidation activity targets a separate, fixed queue. */
  memoryQueues?: boolean;
}

/** A task-owned in-memory server. No production activity implementations load. */
export async function createSandbox(options: SandboxOptions) {
  const workflowBundle = await getWorkflowBundle();
  const env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "space-synthetic-client" } });
  const queue = "space-memory-maintenance";
  const workers: Worker[] = [];
  const finalizeInitializedWorkers = () => Promise.allSettled(workers
    .filter((worker) => worker.getState() === "INITIALIZED")
    .map((worker) => worker.runUntil(async () => undefined)));
  try {
    for (const taskQueue of options.memoryQueues ? [queue, MEMORY_MUTATION_TASK_QUEUE] : [queue]) {
      workers.push(await Worker.create({
        connection: env.nativeConnection,
        workflowBundle,
        taskQueue,
        identity: "space-synthetic-worker",
        activities: options.activities,
        // SDK-supported patch deferral exercises the retained historical branch
        // with the identical production bundle and without mocking patched().
        patchActivationCallback: options.legacySupervisor
          ? ({ patchId }) => patchId !== "room-background-continuation-v1"
          : undefined,
        shutdownGraceTime: "1s",
        shutdownForceTime: "5s"
      }));
    }
  } catch (error) {
    await finalizeInitializedWorkers();
    await env.teardown();
    throw error;
  }
  return {
    env,
    worker: workers[0]!,
    queue,
    runUntil<T>(fn: () => Promise<T>): Promise<T> {
      const run = workers.reduceRight<() => Promise<T>>(
        (next, worker) => () => worker.runUntil(next), fn
      );
      return run();
    },
    async close() {
      // runUntil shuts down every worker, including when the test throws.
      await finalizeInitializedWorkers();
      await env.teardown();
    }
  };
}
