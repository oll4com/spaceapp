import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import type { WorkflowHandle, WorkflowStartOptions } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { roomAgentSupervisorInputSchema } from "@space/contracts";

export const workflowsPath = fileURLToPath(new URL("./temporal-workflows.ts", import.meta.url));
export const legacyPatch = "room-background-continuation-v1";
export type StubActivities = Record<string, (...args: any[]) => any>;

let bundle: Promise<WorkflowBundleWithSourceMap> | undefined;
let installedRuntime = false;

export function workflowBundle() {
  if (!installedRuntime) {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    installedRuntime = true;
  }
  return bundle ??= bundleWorkflowCode({ workflowsPath, logger: new DefaultLogger("ERROR") });
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function bounded<T>(operation: Promise<T>, description: string, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

export async function eventually<T>(read: () => Promise<T> | T, ready: (value: T) => boolean, description: string): Promise<T> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const value = await read();
    if (ready(value)) return value;
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

export async function waitForTimer(handle: WorkflowHandle, count = 1) {
  return eventually(() => handle.fetchHistory(), history =>
    history.events!.filter(event => event.timerStartedEventAttributes).length >= count, `${count} durable timer(s)`);
}

export async function continuedInput(handle: WorkflowHandle) {
  const history = await eventually(() => handle.fetchHistory(), history =>
    history.events!.some(event => event.workflowExecutionContinuedAsNewEventAttributes), "continue-as-new");
  const attributes = history.events!.find(event => event.workflowExecutionContinuedAsNewEventAttributes)!
    .workflowExecutionContinuedAsNewEventAttributes!;
  const input = defaultPayloadConverter.fromPayload(attributes.input!.payloads![0]!);
  return { input: roomAgentSupervisorInputSchema.parse(input), runId: attributes.newExecutionRunId!, history };
}

/** One ephemeral real server, with sequential workers and no database/provider activities. */
export class Sandbox {
  private queue = "";
  private handles: WorkflowHandle[] = [];
  private constructor(readonly env: TestWorkflowEnvironment) {}

  static async create() {
    await workflowBundle();
    return new Sandbox(await TestWorkflowEnvironment.createTimeSkipping({
      client: { identity: "space-temporal-fixtures" }
    }));
  }

  start(workflowType: string, input: unknown, options: {
    workflowId?: string; followRuns?: boolean; taskQueue?: string;
  } = {}) {
    return this.env.client.workflow.start(workflowType, {
      taskQueue: options.taskQueue ?? this.queue,
      workflowId: options.workflowId ?? `sandbox-${workflowType}-${randomUUID()}`,
      args: [input],
    } as WorkflowStartOptions).then(handle => {
      const firstRun = this.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId, {
        followRuns: options.followRuns ?? true
      });
      this.handles.push(firstRun);
      return firstRun;
    });
  }

  async run(activities: StubActivities, body: (sandbox: Sandbox) => Promise<void>, options: {
    legacy?: boolean; taskQueue?: string; extraTaskQueues?: string[]; timeoutMs?: number;
  } = {}) {
    this.queue = options.taskQueue ?? `sandbox-${randomUUID()}`;
    const queues = [...new Set([this.queue, ...options.extraTaskQueues ?? []])];
    try {
      const run = async (index: number): Promise<void> => {
        if (index === queues.length) {
          try { await bounded(body(this), "sandbox scenario", options.timeoutMs ?? 20_000); }
          finally { await this.terminateChains(); }
          return;
        }
        // Start each worker before creating the next, so a later startup failure
        // is unwound by runUntil rather than leaving initialized workers attached.
        const worker = await Worker.create({
          connection: this.env.nativeConnection,
          taskQueue: queues[index]!,
          workflowBundle: await workflowBundle(),
          activities,
          identity: "space-temporal-fixtures",
          shutdownGraceTime: "0ms",
          shutdownForceTime: "5 seconds",
          maxConcurrentWorkflowTaskPolls: 2,
          maxConcurrentActivityTaskPolls: 2,
          maxHeartbeatThrottleInterval: "10ms",
          defaultHeartbeatThrottleInterval: "10ms",
          // Unlike mocking patched(), this records a real pre-patch history with no marker.
          ...(options.legacy ? { patchActivationCallback: ({ patchId }: { patchId: string }) => patchId !== legacyPatch } : {})
        });
        await worker.runUntil(() => run(index + 1));
      };
      await run(0);
    } finally {
      // Also clean up if worker startup failed. Fetch by workflow ID to terminate CAN successors.
      await this.terminateChains();
    }
  }

  private async terminateChains() {
    for (const handle of this.handles.splice(0)) {
      try { await this.env.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test completed"); }
      catch (error) {
        if (!(error instanceof Error) || error.name !== "WorkflowNotFoundError") throw error;
      }
    }
  }

  async close() {
    try { await this.terminateChains(); } finally { await this.env.teardown(); }
  }
}
