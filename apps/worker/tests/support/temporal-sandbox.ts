import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkflowHandle } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Worker } from "@temporalio/worker";

const workflowsPath = fileURLToPath(new URL("./temporal-workflows.ts", import.meta.url));
const fixtureDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
let bundle: ReturnType<typeof bundleWorkflowCode> | undefined;

export function workflowBundle() {
  return bundle ??= bundleWorkflowCode({
    workflowsPath,
    logger: new DefaultLogger("ERROR"),
    webpackConfigHook: config => ({
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
          "@space/contracts$": fileURLToPath(new URL("../../../../packages/contracts/src/index.ts", import.meta.url))
        }
      }
    })
  });
}

export async function history(handle: Pick<WorkflowHandle, "fetchHistory">) {
  return handle.fetchHistory();
}

export async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for workflow progress`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

interface SandboxOptions {
  activities: Record<string, Function>;
  environment?: TestWorkflowEnvironment;
  legacySupervisor?: boolean;
  taskQueues?: string[];
}

interface SandboxContext {
  env: TestWorkflowEnvironment;
  client: TestWorkflowEnvironment["client"];
  taskQueue: string;
  record: (handle: Pick<WorkflowHandle, "fetchHistory" | "workflowId">, name: string) => Promise<void>;
}

export async function withSandbox<T>(options: SandboxOptions, run: (context: SandboxContext) => Promise<T>): Promise<T> {
  const env = options.environment ?? await TestWorkflowEnvironment.createTimeSkipping();
  const taskQueue = `space-sandbox-${randomUUID()}`;
  try {
    const compiledWorkflows = await workflowBundle();
    const record: SandboxContext["record"] = async (handle, name) => {
      if (process.env.SPACE_RECORD_TEMPORAL_HISTORIES !== "1") return;
      if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid synthetic history name: ${name}`);
      const recorded = await history(handle);
      // Keep replay-relevant payloads/events intact, excluding machine identities
      // and stack traces containing contributor paths. All inputs are synthetic.
      const json = JSON.stringify({ workflowId: handle.workflowId, history: recorded }, (key, value) =>
        key === "identity" ? "space-synthetic-test-worker" : key === "stackTrace" ? "" : value, 2);
      await mkdir(fixtureDirectory, { recursive: true });
      await writeFile(join(fixtureDirectory, `${name}.json`), `${json}\n`);
    };
    const queues = [...new Set([taskQueue, ...options.taskQueues ?? []])];
    const runWorkers = async (index: number): Promise<T> => {
      if (index === queues.length) return run({ env, client: env.client, taskQueue, record });
      const worker = await Worker.create({
        connection: env.nativeConnection,
        taskQueue: queues[index]!,
        identity: "space-synthetic-test-worker",
        workflowBundle: compiledWorkflows,
        activities: options.activities,
        maxHeartbeatThrottleInterval: "100ms",
        defaultHeartbeatThrottleInterval: "100ms",
        shutdownGraceTime: "1 second",
        patchActivationCallback: ({ patchId }) => !(options.legacySupervisor && patchId === "room-background-continuation-v1")
      });
      // Start each worker before constructing the next, so runUntil drains it
      // even if a later worker cannot be created.
      return worker.runUntil(() => runWorkers(index + 1));
    };
    return await runWorkers(0);
  } finally {
    if (!options.environment) await env.teardown();
  }
}
