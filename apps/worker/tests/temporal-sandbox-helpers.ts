import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker, bundleWorkflowCode } from "@temporalio/worker";
import { temporal } from "@temporalio/proto";
import {
  dummyTurnInputSchema, dummyTurnResultSchema, roomAgentSupervisorQueueItemSchema,
  spaceAgentRoomActionBridgeRequestSchema, spaceAgentRoomActionBridgeResponseSchema,
  memoryConsolidationRunSchema, memoryMaintenanceResultSchema,
  MEMORY_MUTATION_TASK_QUEUE, MEMORY_CONSOLIDATION_TASK_QUEUE,
  type DummyTurnInput
} from "@space/contracts";

export { MEMORY_MUTATION_TASK_QUEUE, MEMORY_CONSOLIDATION_TASK_QUEUE };
export const here = path.dirname(fileURLToPath(import.meta.url));
export const fixtureDirectory = path.join(here, "fixtures/workflow-histories");
export const workflowPath = path.resolve(here, "../src/workflows.ts");
export const workflowPaths = {
  turns: workflowPath,
  maintenance: path.resolve(here, "../src/memory-maintenance-workflows.ts"),
  mutation: path.resolve(here, "../src/memory-mutation-workflows.ts")
};
export const eventType = temporal.api.enums.v1.EventType;
export const syntheticTime = "2026-01-01T00:00:00.000Z";
export const sourceHash = "a".repeat(64);
export function turn(index = 0) {
  return dummyTurnInputSchema.parse({ roomId: "room:temporal-fixture", paneId: "pane:temporal-fixture",
    prompt: `Synthetic request ${index}`, agentRunId: `agent_run:fixture-${index}`, traceId: `trace:fixture-${index}` });
}
export function item(index = 0, missionId = "mission:temporal-fixture") {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: turn(index) });
}
export function turnResult(input: DummyTurnInput) {
  return { workflowId: "workflow:synthetic", roomId: input.roomId, paneId: input.paneId,
    traceId: input.traceId, status: "COMPLETED" as const, message: "Synthetic result",
    roomAgentOutcome: { status: "VERIFIED" as const, executedActionCount: 1, statusReason: "Synthetic verification" } };
}
export function actionInput() {
  return { traceId: "trace:synthetic-action", bridge: spaceAgentRoomActionBridgeRequestSchema.parse({
    roomId: turn().roomId, missionId: item().missionId, agentPaneId: turn().paneId,
    agentSessionId: "session:synthetic", selectedToolIds: ["room:send"],
    actions: [{ toolId: "room:send", action: { type: "send", paneId: turn().paneId, input: "Synthetic message" } }]
  }) };
}
export function actionResult() {
  return spaceAgentRoomActionBridgeResponseSchema.parse({ id: "space-agent-room-action-bridge", results: [{
    request: actionInput().bridge.actions[0], status: "EXECUTED", statusReason: "Synthetic action completed",
    paneId: turn().paneId, missionId: item().missionId, evidence: {}
  }] });
}
export function maintenanceResult() {
  return memoryMaintenanceResultSchema.parse({ status: "REFRESHED", generatedAt: syntheticTime,
    sourceHash, previousSourceHash: null, durationMs: 1,
    summary: { sourceCount: 1, recordCount: 1, nodeCount: 1, edgeCount: 0, issueCount: 0 } });
}
export function consolidationResult(id = "audit:synthetic") {
  return memoryConsolidationRunSchema.parse({ id, mode: "REPAIR", triggerKind: "SCHEDULED", status: "SUCCEEDED",
    workflowId: "workflow:synthetic-consolidation", dedupeKey: "dedupe:synthetic", sourceHash,
    actorUserId: null, progressCompleted: 1, progressTotal: 1, findingCount: 0, appliedOperationCount: 1,
    skippedOperationCount: 0, failedOperationCount: 0, metrics: {}, modelId: null, aiVerified: false,
    aiEvidence: {}, statusReason: null, createdAt: syntheticTime, startedAt: syntheticTime,
    completedAt: syntheticTime, updatedAt: syntheticTime });
}
export function activities() {
  return {
    recordDummyTurnStarted: async () => ({ workflowId: "workflow:synthetic" }),
    recordDummyTurnCompleted: async (input: DummyTurnInput) => dummyTurnResultSchema.parse(turnResult(input)),
    runCodexAppServerTurn: async (input: DummyTurnInput) => turnResult(input),
    runOpenCodeAgentTurn: async (input: DummyTurnInput) => turnResult(input),
    runCliAgentTurn: async (input: DummyTurnInput) => turnResult(input),
    dotGoalStep: async (_goalId: string) => ({ state: "DONE", runId: null as string | null, goalStatus: "COMPLETED" }),
    dotGoalObserve: async (_goalId: string, _runId: string) => ({ run: "COMPLETED", goalStatus: "COMPLETED" }),
    markRoomAgentMissionStarted: async (_input: unknown) => {},
    markRoomAgentMissionFinished: async (_input: unknown) => {},
    markRoomAgentMissionContinued: async (_input: unknown) => {},
    checkRoomAgentSupervisorTurn: async (_input: unknown): Promise<"READY" | "PAUSED" | "SKIP"> => "READY",
    discardRoomAgentSupervisorTurn: async (_input: unknown) => {},
    finishRoomAgentSupervisorTurn: async (_input: unknown) => {},
    prepareRoomAgentBackgroundContinuation: async (_input: unknown): Promise<{ state: "DONE" | "WAITING" } | { state: "READY"; item: ReturnType<typeof item> }> => ({ state: "DONE" }),
    settleRoomAgentBackgroundMission: async (_input: unknown) => true,
    runRoomAgentBackgroundAction: async (_input: unknown) => actionResult(),
    failRoomAgentBackgroundAction: async (_input: unknown) => {},
    refreshMemoryGraphSnapshot: async (_input: unknown) => maintenanceResult(),
    refreshAllMonthsMemoryGraphSnapshot: async (_input: unknown) => {},
    reconcileStaleSpaceAgentSessions: async () => {},
    createScheduledMemoryAudit: async (_input: unknown) => ({ id: "audit:synthetic", workflowId: "workflow:synthetic-consolidation" }),
    prepareMemoryConsolidation: async (input: { runId: string }) => ({ run: consolidationResult(input.runId), changeSetId: "changeset:synthetic" }),
    finalizeMemoryRepair: async (input: { runId: string }) => consolidationResult(input.runId),
    executePersistedMemoryChangeSet: async (input: { changeSetId: string }) => ({ status: "APPLIED" as const, changeSetId: input.changeSetId, resultingSourceHash: sourceHash, reason: null })
  };
}
export async function environment() {
  // CI downloads through the SDK. Contained/offline runs can use a separately acquired executable.
  const executable = process.env.TEMPORAL_TEST_SERVER_EXECUTABLE;
  return TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "spaceapp-synthetic-fixture-client" },
    ...(executable ? { server: { executable: { type: "existing-path" as const, path: executable } } } : {}) });
}
export async function bundle(kind: keyof typeof workflowPaths, legacy = false) {
  return bundleWorkflowCode({ workflowsPath: workflowPaths[kind],
    ...(legacy ? { webpackConfigHook: (config) => {
      config.module ??= {}; config.module.rules ??= [];
      config.module.rules.push({ test: /[/\\]src[/\\]workflows\.ts$/, use: [{ loader: path.join(here, "fixtures/legacy-workflow-loader.cjs") }] });
      return config;
    } } : {}) });
}
export async function worker(env: TestWorkflowEnvironment, workflowBundle: Awaited<ReturnType<typeof bundle>>, taskQueue: string, stubs = activities()) {
  return Worker.create({ connection: env.nativeConnection, workflowBundle, taskQueue, activities: stubs,
    identity: "spaceapp-synthetic-fixture-worker",
    maxConcurrentWorkflowTaskExecutions: 4, maxConcurrentActivityTaskExecutions: 4 });
}
export async function saveHistory(name: string, history: temporal.api.history.v1.IHistory) {
  if (process.env.RECORD_WORKFLOW_HISTORIES !== "1") return;
  await fs.mkdir(fixtureDirectory, { recursive: true });
  const json = temporal.api.history.v1.History.toObject(temporal.api.history.v1.History.fromObject(history),
    { longs: String, enums: String, bytes: String });
  await fs.writeFile(path.join(fixtureDirectory, `${name}.json`), JSON.stringify(json, null, 2) + "\n");
}
export async function loadHistory(name: string) {
  return temporal.api.history.v1.History.fromObject(JSON.parse(await fs.readFile(path.join(fixtureDirectory, `${name}.json`), "utf8")));
}
