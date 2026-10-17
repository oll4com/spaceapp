import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { bundleWorkflowCode, DefaultLogger, Runtime, Worker, type WorkflowBundleWithSourceMap } from "@temporalio/worker";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Context } from "@temporalio/activity";
import { roomAgentSupervisorQueueItemSchema, roomAgentSupervisorInputSchema } from "@space/contracts";

export const historyDirectory = fileURLToPath(new URL("../fixtures/workflow-histories/", import.meta.url));
export const workflowsPath = fileURLToPath(new URL("./sandbox-workflows.ts", import.meta.url));
export const logger = new DefaultLogger("ERROR");
Runtime.install({ logger });

export async function bundle(variant?: "legacy" | "invalid") {
  return bundleWorkflowCode({ workflowsPath, logger, webpackConfigHook(config) {
    // Source aliases let this suite run before an unrelated workspace build.
    config.resolve ??= {};
    config.resolve.alias = { ...config.resolve.alias, "@space/contracts": fileURLToPath(new URL("../../../../packages/contracts/src/index.ts", import.meta.url)) };
    if (variant) {
      config.module ??= {};
      config.module.rules ??= [];
      config.module.rules.push({ test: /worker[\\/]src[\\/]workflows\.ts$/, enforce: "pre",
        use: [{ loader: fileURLToPath(new URL("./workflow-variant.cjs", import.meta.url)), options: { variant } }] });
    }
    return config;
  } });
}

export function item(suffix: string, continuation = false) {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId: "mission:synthetic", turn: {
    roomId: "room:synthetic", paneId: "pane:synthetic", prompt: "Synthetic sandbox request",
    traceId: `trace:${suffix}`, agentRunId: `agent_run:${suffix}`,
    ...(continuation ? { roomAgentContinuation: { sourceRunId: "agent_run:previous", generation: 1 } } : {})
  } });
}
export function supervisor(overrides: Record<string, unknown> = {}) {
  return roomAgentSupervisorInputSchema.parse({ roomId: "room:synthetic", ...overrides });
}
export const completed = { status: "COMPLETED", message: "Synthetic completion", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic verified result" } };

// Activities only return synthetic data; there is no application store/provider.
export function activities(overrides: Record<string, (...args: any[]) => any> = {}): Record<string, (...args: any[]) => any> {
  return {
    recordDummyTurnStarted: async () => undefined,
    recordDummyTurnCompleted: async () => completed,
    runCodexAppServerTurn: async () => completed,
    runOpenCodeAgentTurn: async () => completed,
    runCliAgentTurn: async () => completed,
    runRoomAgentBackgroundAction: async () => completed,
    failRoomAgentBackgroundAction: async () => undefined,
    dotGoalStep: async () => ({ state: "DONE", runId: null, goalStatus: "COMPLETED" }),
    dotGoalObserve: async () => ({ run: "COMPLETED", goalStatus: "ACTIVE" }),
    checkRoomAgentSupervisorTurn: async () => "RUN",
    discardRoomAgentSupervisorTurn: async () => undefined,
    finishRoomAgentSupervisorTurn: async () => undefined,
    prepareRoomAgentBackgroundContinuation: async () => ({ state: "DONE" }),
    settleRoomAgentBackgroundMission: async () => true,
    markRoomAgentMissionStarted: async () => undefined,
    markRoomAgentMissionFinished: async () => undefined,
    markRoomAgentMissionContinued: async () => undefined,
    refreshMemoryGraphSnapshot: async () => ({ sourceHash: "synthetic-source" }),
    refreshAllMonthsMemoryGraphSnapshot: async () => undefined,
    reconcileStaleSpaceAgentSessions: async () => undefined,
    createScheduledMemoryAudit: async () => ({ id: "run:synthetic", workflowId: `consolidate:${randomUUID()}` }),
    prepareMemoryConsolidation: async () => ({ changeSetId: "change:synthetic", run: { id: "run:synthetic" } }),
    executePersistedMemoryChangeSet: async () => ({ changeSetId: "change:synthetic", status: "APPLIED" }),
    finalizeMemoryRepair: async () => ({ id: "run:synthetic", status: "COMPLETED" }),
    ...overrides
  };
}
export { Context, TestWorkflowEnvironment, Worker };
export type Sandbox = { env: TestWorkflowEnvironment; bundle: WorkflowBundleWithSourceMap };

export async function withWorkers<T>(sandbox: Sandbox, stubs: ReturnType<typeof activities>, run: (queue: string) => Promise<T>, memoryQueues = false) {
  const queue = `sandbox:${randomUUID()}`;
  // Child maintenance and mutation activities deliberately use fixed queues.
  const queues = memoryQueues ? [queue, "space-memory-maintenance", "space-memory-mutations"] : [queue];
  const workers = await Promise.all(queues.map(taskQueue => Worker.create({
    connection: sandbox.env.nativeConnection, taskQueue, workflowBundle: sandbox.bundle, activities: stubs,
    maxConcurrentActivityTaskExecutions: 20, shutdownGraceTime: "1 second", shutdownForceTime: "5 seconds", workflowThreadPoolSize: 1,
    maxHeartbeatThrottleInterval: "100 milliseconds", defaultHeartbeatThrottleInterval: "100 milliseconds"
  })));
  const runWith = (index: number): Promise<T> => index === workers.length
    ? run(queue) : workers[index]!.runUntil(() => runWith(index + 1));
  return runWith(0);
}

export async function saveHistory(name: string, handle: { fetchHistory(): Promise<any> }) {
  const history = await handle.fetchHistory();
  if (process.env.SPACE_RECORD_TEMPORAL_HISTORIES === "1") {
    await mkdir(historyDirectory, { recursive: true });
    // SDK's protobuf toJSON encoding preserves uint64/base64 round-trippably.
    await writeFile(`${historyDirectory}/${name}.json`, JSON.stringify(history.toJSON(), (key, value) =>
      key === "stackTrace" ? "" : key === "identity" ? "synthetic-worker" : value, 2) + "\n");
  }
  return history;
}
export async function histories() {
  const { temporal } = await import("@temporalio/proto");
  const files = (await readdir(historyDirectory)).filter(f => f.endsWith(".json")).sort();
  if (!files.length) throw new Error("No committed Temporal history fixtures");
  return Promise.all(files.map(async file => ({ workflowId: file,
    history: temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(`${historyDirectory}/${file}`, "utf8"))) })));
}
