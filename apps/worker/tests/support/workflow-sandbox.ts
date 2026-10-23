import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import type { ActivityFunction } from "@temporalio/common";
import { bundleWorkflowCode, DefaultLogger, Worker, type WorkflowBundle } from "@temporalio/worker";
import { MEMORY_MUTATION_TASK_QUEUE } from "@space/contracts";

let bundle: Promise<WorkflowBundle> | undefined;

/** Caches one bundle of all eight production workflow exports, including their real child implementations. */
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

/**
 * Creates an isolated time-skipping server and workers with injected activities, never production activity code.
 * Optional memory workers serve the fixed mutation queue; legacy mode defers only the supervisor's patch.
 * Call close() in a finally block, including when the scenario never reaches runUntil().
 */
export async function createSandbox(options: SandboxOptions) {
  const workflowBundle = await getWorkflowBundle();
  const env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "space-synthetic-client" } });
  const queue = "space-memory-maintenance";
  const workers: Worker[] = [];
  /** Starts and drains unused workers so partial setup failures do not retain native worker resources. */
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
    /** Runs every queue worker around the scenario and waits for their shutdown if it succeeds or throws. */
    runUntil<T>(fn: () => Promise<T>): Promise<T> {
      const run = workers.reduceRight<() => Promise<T>>(
        (next, worker) => () => worker.runUntil(next), fn
      );
      return run();
    },
    /** Releases any workers not yet run, then tears down the task-owned test server. */
    async close() {
      // runUntil shuts down every worker, including when the test throws.
      await finalizeInitializedWorkers();
      await env.teardown();
    }
  };
}
