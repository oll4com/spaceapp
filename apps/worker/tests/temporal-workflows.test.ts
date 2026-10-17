import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { ApplicationFailure } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import proto from "@temporalio/proto";
import { DeterminismViolationError } from "@temporalio/workflow";
import { fileURLToPath } from "node:url";
import { DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema } from "@space/contracts";
import { MEMORY_MAINTENANCE_TASK_QUEUE } from "../src/memory-maintenance-config.js";
import { MEMORY_MUTATION_TASK_QUEUE } from "../src/memory-mutation-config.js";
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const TASK_QUEUE = "workflow-integration-tests";
const MAINTENANCE_QUEUE = MEMORY_MAINTENANCE_TASK_QUEUE;
const MUTATION_QUEUE = MEMORY_MUTATION_TASK_QUEUE;
const LEGACY_QUEUE = "workflow-integration-legacy-tests";
const workflowsPath = fileURLToPath(new URL("./temporal-workflow-entry.ts", import.meta.url));
const historyDirectory = fileURLToPath(new URL("./fixtures/workflow-histories/", import.meta.url));
const sourceHash = "a".repeat(64);
const memoryResult = {
  status: "REFRESHED", generatedAt: "2026-01-01T00:00:00.000Z", sourceHash,
  previousSourceHash: null, summary: { sourceCount: 0, recordCount: 0 }, durationMs: 1
};

let env: TestWorkflowEnvironment;
let primaryWorker: Worker;
let maintenanceWorker: Worker;
let mutationWorker: Worker;
let legacyWorker: Worker;
let primaryRun: Promise<void>;
let maintenanceRun: Promise<void>;
let mutationRun: Promise<void>;
let legacyRun: Promise<void>;
const calls = new Map<string, number>();
const finishedLegacyMissionIds: string[] = [];
const checkedSupervisorTurns: string[] = [];
const options = new Map<string, "fail-once" | "always-fail">();
let supervisorReady: (() => void) | undefined;
let dotGoalMode: "done" | "waiting" | "long" = "done";
let dotGoalCalls = 0;
let dotGoalWaiting: (() => void) | undefined;
let supervisorPrepareMode: "DONE" | "WAIT" | "READY-GATED" | "READY-ONCE" = "DONE";
let supervisorTurnMode: "SKIP" | "PAUSED" | "ACTIVE" = "SKIP";
let supervisorPrepareStarted: (() => void) | undefined;
let supervisorPrepareResume: (() => void) | undefined;
let supervisorPreparedItem: unknown;
let onSupervisorCheck: ((item: { turn: { agentRunId?: string } }) => Promise<void>) | undefined;
let turnActivityGate: { started(): void; wait: Promise<void> } | undefined;
let legacySettleResult = true;
let consolidationMode: "normal" | "repair" = "normal";
const discardedSupervisorTurns: Array<{ item: unknown; reason: string }> = [];
const finishedSupervisorTurns: Array<{ item: unknown; status: string; statusReason?: string }> = [];
const checkedSupervisorItems: Array<{ missionId: string; turn: { agentRunId?: string; roomAgentContinuation?: unknown } }> = [];
const turnActivityResults: unknown[] = [];

/**
 * Extracts and parses JSON continue-as-new input payload from workflow execution history.
 *
 * @param history Workflow execution history object.
 * @returns Parsed input object.
 */
function continuedAsNewInput(history: unknown): Record<string, unknown> {
  const events = (history as { events: Array<{
    eventType: number;
    workflowExecutionContinuedAsNewEventAttributes?: { input?: { payloads?: Array<{ data: Uint8Array }> } };
  }> }).events;
  const event = events.find(candidate => candidate.eventType === proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW);
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0]?.data;
  if (!payload) throw new Error("History has no continue-as-new input payload.");
  return JSON.parse(Buffer.from(payload).toString("utf8")) as Record<string, unknown>;
}

/**
 * Records workflow execution history to disk when TEMPORAL_RECORD_WORKFLOW_HISTORIES is enabled.
 *
 * @param handle Workflow handle with fetchHistory capability.
 * @param name Output JSON fixture base filename.
 */
async function recordHistory(handle: { workflowId: string; fetchHistory(): Promise<unknown> }, name: string): Promise<void> {
  if (process.env.TEMPORAL_RECORD_WORKFLOW_HISTORIES !== "1") return;
  await mkdir(historyDirectory, { recursive: true });
  const history = await handle.fetchHistory();
  await writeFile(join(historyDirectory, `${name}.json`), `${JSON.stringify({ workflowId: handle.workflowId, history }, null, 2)}\n`, "utf8");
}

/**
 * Records and increments invocation counter for synthetic activity stubs.
 *
 * @param name Name of activity called.
 * @returns New invocation count.
 */
function called(name: string): number {
  const count = (calls.get(name) ?? 0) + 1;
  calls.set(name, count);
  return count;
}

/**
 * Creates synthetic activity error with clean stack trace.
 *
 * @param message Error message.
 * @returns Error instance.
 */
function syntheticActivityError(message: string): Error {
  const error = new Error(message);
  error.stack = `${error.name}: ${error.message}`;
  return error;
}

/**
 * Creates synthetic non-retryable ApplicationFailure with clean stack trace.
 *
 * @param message Failure message.
 * @returns ApplicationFailure instance.
 */
function syntheticApplicationFailure(message: string): ApplicationFailure {
  const failure = ApplicationFailure.nonRetryable(message);
  failure.stack = `${failure.name}: ${failure.message}`;
  return failure;
}

const activities = {
  recordDummyTurnStarted: async () => { called("recordDummyTurnStarted"); return { workflowId: "synthetic" }; },
  recordDummyTurnCompleted: async () => { called("recordDummyTurnCompleted"); return { status: "COMPLETED", message: "synthetic" }; },
  runCodexAppServerTurn: async () => {
    called("runCodexAppServerTurn");
    if (turnActivityGate) {
      turnActivityGate.started();
      await turnActivityGate.wait;
    }
    if (options.get("runCodexAppServerTurn") === "fail-once" && Context.current().info.attempt === 1) throw syntheticActivityError("synthetic retry");
    if (turnActivityResults.length) return turnActivityResults.shift();
    return { status: "COMPLETED", message: "synthetic" };
  },
  runOpenCodeAgentTurn: async () => ({ status: "COMPLETED", message: "synthetic" }),
  runCliAgentTurn: async () => ({ status: "COMPLETED", message: "synthetic" }),
  runRoomAgentBackgroundAction: async () => {
    called("runRoomAgentBackgroundAction");
    if (options.get("runRoomAgentBackgroundAction") === "always-fail") throw syntheticApplicationFailure("synthetic activity failure");
    return { status: "COMPLETED" };
  },
  failRoomAgentBackgroundAction: async () => { called("failRoomAgentBackgroundAction"); },
  dotGoalStep: async () => {
    dotGoalCalls++;
    called("dotGoalStep");
    if (dotGoalMode === "waiting" && dotGoalCalls === 1) { dotGoalWaiting?.(); return { state: "WAITING", runId: null, goalStatus: "ACTIVE" }; }
    if (dotGoalMode === "long" && dotGoalCalls <= 300) return { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
    return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
  },
  checkRoomAgentSupervisorTurn: async (item: { missionId: string; turn: { agentRunId?: string } }) => {
    called("checkRoomAgentSupervisorTurn");
    checkedSupervisorItems.push(item);
    if (item.turn?.agentRunId) checkedSupervisorTurns.push(item.turn.agentRunId);
    if (onSupervisorCheck) await onSupervisorCheck(item);
    if (supervisorTurnMode === "PAUSED") return "PAUSED";
    if (supervisorTurnMode === "ACTIVE") return "ACTIVE";
    return "SKIP";
  },
  discardRoomAgentSupervisorTurn: async (input: { item: unknown; reason: string }) => {
    called("discardRoomAgentSupervisorTurn");
    discardedSupervisorTurns.push(input);
  },
  finishRoomAgentSupervisorTurn: async (input: { item: unknown; status: string; statusReason?: string }) => {
    called("finishRoomAgentSupervisorTurn");
    finishedSupervisorTurns.push(input);
  },
  settleRoomAgentBackgroundMission: async () => {
    called("settleRoomAgentBackgroundMission");
    return legacySettleResult;
  },
  markRoomAgentMissionStarted: async () => { called("markRoomAgentMissionStarted"); },
  markRoomAgentMissionFinished: async (input: { missionId: string }) => {
    called("markRoomAgentMissionFinished");
    finishedLegacyMissionIds.push(input.missionId);
  },
  prepareRoomAgentBackgroundContinuation: async () => {
    called("prepareRoomAgentBackgroundContinuation");
    if (supervisorPrepareMode === "WAIT") return { state: "WAIT" };
    if (supervisorPrepareMode === "READY-GATED") {
      supervisorPrepareStarted?.();
      await new Promise<void>(resolve => { supervisorPrepareResume = resolve; });
      return { state: "READY", item: supervisorPreparedItem };
    }
    if (supervisorPrepareMode === "READY-ONCE") {
      supervisorPrepareMode = "DONE";
      return { state: "READY", item: supervisorPreparedItem };
    }
    return supervisorPrepareMode === "WAIT" ? { state: "WAIT" } : { state: "DONE" };
  },
  refreshMemoryGraphSnapshot: async () => { called("refreshMemoryGraphSnapshot"); return memoryResult; },
  refreshAllMonthsMemoryGraphSnapshot: async () => {
    called("refreshAllMonthsMemoryGraphSnapshot");
    if (options.has("refreshAllMonthsMemoryGraphSnapshot")) throw syntheticActivityError("synthetic optional refresh failure");
  },
  reconcileStaleSpaceAgentSessions: async () => {
    called("reconcileStaleSpaceAgentSessions");
    if (options.has("reconcileStaleSpaceAgentSessions")) throw syntheticActivityError("synthetic optional reconciliation failure");
  },
  createScheduledMemoryAudit: async () => {
    called("createScheduledMemoryAudit");
    return { id: "run:synthetic", workflowId: "memory-consolidation:synthetic" };
  },
  prepareMemoryConsolidation: async () => {
    called("prepareMemoryConsolidation");
    if (consolidationMode === "repair") {
      return {
        run: { id: "run:synthetic-repair", status: "COMPLETED" },
        changeSetId: "change:synthetic-repair"
      };
    }
    return { run: { id: "run:synthetic", status: "COMPLETED" } };
  },
  finalizeMemoryRepair: async () => {
    called("finalizeMemoryRepair");
    return { id: "run:synthetic-repair", status: "COMPLETED" };
  },
  executePersistedMemoryChangeSet: async () => {
    called("executePersistedMemoryChangeSet");
    if (options.get("executePersistedMemoryChangeSet") === "fail-once" && Context.current().info.attempt === 1) throw syntheticActivityError("synthetic retry");
    return { status: "DISABLED", changeSetId: "change:synthetic", resultingSourceHash: null, reason: null };
  }
};

const roomTurn = {
  roomId: "room:temporal-test", paneId: "pane:temporal-test", prompt: "synthetic workflow test",
  artifactIds: [], traceId: "trace:temporal-test", agentRunId: "run:temporal-test"
};

beforeAll(async () => {
  env = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-worker" } });
  const connection = env.nativeConnection;
  primaryWorker = await Worker.create({
    connection, taskQueue: TASK_QUEUE, workflowsPath, activities,
    identity: "synthetic-worker"
  });
  maintenanceWorker = await Worker.create({
    connection, taskQueue: MAINTENANCE_QUEUE, workflowsPath, activities,
    identity: "synthetic-worker"
  });
  mutationWorker = await Worker.create({
    connection, taskQueue: MUTATION_QUEUE, workflowsPath, activities,
    identity: "synthetic-worker"
  });
  legacyWorker = await Worker.create({
    connection, taskQueue: LEGACY_QUEUE, workflowsPath, activities,
    identity: "synthetic-worker",
    patchActivationCallback: () => false
  });
  primaryRun = primaryWorker.run();
  maintenanceRun = maintenanceWorker.run();
  mutationRun = mutationWorker.run();
  legacyRun = legacyWorker.run();
});

afterAll(async () => {
  primaryWorker?.shutdown(); maintenanceWorker?.shutdown(); mutationWorker?.shutdown(); legacyWorker?.shutdown();
  await Promise.allSettled([primaryRun, maintenanceRun, mutationRun, legacyRun]);
  await env?.teardown();
});

describe.sequential("Temporal workflow integration", () => {
  it("runs dummyTurnWorkflow and codexAppServerTurnWorkflow with the real sandbox", async () => {
    const dummyHandle = await env.client.workflow.start("dummyTurnWorkflow", { taskQueue: TASK_QUEUE, workflowId: "dummy-synthetic", args: [roomTurn] });
    const dummy = await dummyHandle.result();
    expect(dummy.status).toBe("COMPLETED");
    await recordHistory(dummyHandle, "dummy-turn");

    options.set("runCodexAppServerTurn", "fail-once");
    const turnHandle = await env.client.workflow.start("codexAppServerTurnWorkflow", { taskQueue: TASK_QUEUE, workflowId: "turn-retry-synthetic", args: [roomTurn] });
    const turn = await turnHandle.result();
    options.delete("runCodexAppServerTurn");
    expect(turn.status).toBe("COMPLETED");
    expect(calls.get("runCodexAppServerTurn")).toBe(2);
    await recordHistory(turnHandle, "codex-app-server-turn-retry");
  });

  it("runs dotGoalWorkflow and the patched roomAgentActionWorkflow failure path", async () => {
    dotGoalMode = "waiting";
    dotGoalCalls = 0;
    const goalWaiting = new Promise<void>(resolve => { dotGoalWaiting = resolve; });
    const wakeHandle = await env.client.workflow.start("dotGoalWorkflow", { taskQueue: TASK_QUEUE, workflowId: "dot-goal-wake-synthetic", args: [{ goalId: "goal:wake" }] });
    await goalWaiting;
    await wakeHandle.signal(DOT_GOAL_SIGNAL);
    expect((await wakeHandle.result()).goalStatus).toBe("COMPLETED");
    await recordHistory(wakeHandle, "dot-goal-wake");
    dotGoalWaiting = undefined;

    dotGoalMode = "waiting";
    dotGoalCalls = 0;
    const timeoutWaiting = new Promise<void>(resolve => { dotGoalWaiting = resolve; });
    const timeoutHandle = await env.client.workflow.start("dotGoalWorkflow", { taskQueue: TASK_QUEUE, workflowId: "dot-goal-timeout-synthetic", args: [{ goalId: "goal:timeout" }] });
    await timeoutWaiting;
    await env.sleep("35 seconds");
    expect((await timeoutHandle.result()).goalStatus).toBe("COMPLETED");
    await recordHistory(timeoutHandle, "dot-goal-timeout");
    dotGoalWaiting = undefined;

    dotGoalMode = "long";
    dotGoalCalls = 0;
    const continueHandle = await env.client.workflow.start("dotGoalWorkflow", { taskQueue: TASK_QUEUE, workflowId: "dot-goal-continue-synthetic", args: [{ goalId: "goal:continue" }] });
    const firstRun = env.client.workflow.getHandle("dot-goal-continue-synthetic", continueHandle.firstExecutionRunId);
    expect((await continueHandle.result()).goalStatus).toBe("COMPLETED");
    await recordHistory(firstRun, "dot-goal-continue-as-new");
    dotGoalMode = "done";

    options.set("runRoomAgentBackgroundAction", "always-fail");
    const actionInput = {
      actionId: "action:failure-test",
      bridge: { roomId: roomTurn.roomId, missionId: "mission:action-failure" },
      turn: roomTurn
    };
    const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
      taskQueue: TASK_QUEUE,
      workflowId: "room-action-failure-synthetic",
      args: [actionInput]
    });
    await expect(handle.result()).rejects.toThrow();
    expect(calls.get("failRoomAgentBackgroundAction")).toBe(1);
    await recordHistory(handle, "room-action-failure");
    options.delete("runRoomAgentBackgroundAction");
  }, 30_000);

  it("runs the unpatched roomAgentActionWorkflow failure path without emitting patch activity", async () => {
    options.set("runRoomAgentBackgroundAction", "always-fail");
    const actionInput = {
      actionId: "action:unpatched-failure-test",
      bridge: { roomId: roomTurn.roomId, missionId: "mission:action-unpatched-failure" },
      turn: roomTurn
    };
    const failsBefore = calls.get("failRoomAgentBackgroundAction") ?? 0;
    const handle = await env.client.workflow.start("roomAgentActionWorkflow", {
      taskQueue: LEGACY_QUEUE,
      workflowId: "room-action-unpatched-synthetic",
      args: [actionInput]
    });
    await expect(handle.result()).rejects.toThrow();
    // Legacy unpatched path does not invoke failRoomAgentBackgroundAction
    expect(calls.get("failRoomAgentBackgroundAction") ?? 0).toBe(failsBefore);
    await recordHistory(handle, "room-action-unpatched-failure");
    options.delete("runRoomAgentBackgroundAction");
  }, 30_000);

  it("runs memoryMaintenanceWorkflow after optional failures and starts consolidation as a child", async () => {
    options.set("refreshAllMonthsMemoryGraphSnapshot", "always-fail");
    options.set("reconcileStaleSpaceAgentSessions", "always-fail");
    const maintenanceHandle = await env.client.workflow.start("memoryMaintenanceWorkflow", {
      taskQueue: MAINTENANCE_QUEUE, workflowId: "memory-maintenance-synthetic",
      args: [{ scheduledAt: "2026-01-01T00:00:00.000Z", traceId: "trace:maintenance" }]
    });
    const result = await maintenanceHandle.result();
    options.clear();
    expect(result.status).toBe("REFRESHED");
    expect(calls.get("createScheduledMemoryAudit")).toBe(1);
    expect(calls.get("prepareMemoryConsolidation")).toBe(1);
    await recordHistory(maintenanceHandle, "memory-maintenance");
    const childHandle = env.client.workflow.getHandle("memory-consolidation:synthetic");
    await recordHistory(childHandle, "memory-consolidation-child");
  }, 30_000);

  it("runs memoryConsolidationWorkflow directly with retry on mutations queue and finalizes repair", async () => {
    const beforeMutations = calls.get("executePersistedMemoryChangeSet") ?? 0;
    options.set("executePersistedMemoryChangeSet", "fail-once");
    consolidationMode = "repair";
    const repairInput = { runId: "run:repair-test", traceId: "trace:repair" };
    const repairHandle = await env.client.workflow.start("memoryConsolidationWorkflow", {
      taskQueue: MAINTENANCE_QUEUE,
      workflowId: "memory-consolidation-repair-synthetic",
      args: [repairInput]
    });
    const runResult = await repairHandle.result();
    options.delete("executePersistedMemoryChangeSet");
    consolidationMode = "normal";
    expect(runResult.status).toBe("COMPLETED");
    expect(calls.get("prepareMemoryConsolidation")).toBeGreaterThanOrEqual(1);
    expect((calls.get("executePersistedMemoryChangeSet") ?? 0) - beforeMutations).toBe(2);
    expect(calls.get("finalizeMemoryRepair")).toBe(1);
    await recordHistory(repairHandle, "memory-consolidation-repair");
  }, 30_000);

  it("runs memoryMutationWorkflow and retries mutation activities in the configured task queue", async () => {
    const beforeMutations = calls.get("executePersistedMemoryChangeSet") ?? 0;
    options.set("executePersistedMemoryChangeSet", "fail-once");
    const result = await env.client.workflow.execute("memoryMutationWorkflow", {
      taskQueue: MUTATION_QUEUE, workflowId: "memory-mutation-retry-synthetic",
      args: [{ changeSetId: "change:synthetic", traceId: "trace:mutation" }]
    });
    options.delete("executePersistedMemoryChangeSet");
    expect(result.status).toBe("DISABLED");
    expect((calls.get("executePersistedMemoryChangeSet") ?? 0) - beforeMutations).toBe(2);
    await recordHistory(env.client.workflow.getHandle("memory-mutation-retry-synthetic"), "memory-mutation-retry");
  });

  it("handles real roomAgentSupervisorWorkflow enqueue and stop signals with cancellation in real sandbox", async () => {
    supervisorTurnMode = "PAUSED";
    const queued = roomAgentSupervisorInputSchema.parse({ roomId: roomTurn.roomId });
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: TASK_QUEUE, workflowId: "room-supervisor-synthetic", args: [queued]
    });
    const item = { missionId: "mission:synthetic", turn: { ...roomTurn, agentRunId: "run:queued-synthetic" } };
    await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item);
    await vi.waitFor(() => expect(calls.get("checkRoomAgentSupervisorTurn")).toBe(1));
    await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:synthetic", reason: "synthetic stop" });
    await vi.waitFor(() => expect(calls.get("discardRoomAgentSupervisorTurn")).toBeGreaterThan(0));
    await vi.waitFor(() => expect(finishedSupervisorTurns.some(turn =>
      (turn.item as { missionId: string }).missionId === "mission:synthetic" && turn.status === "INTERRUPTED"
    )).toBe(true));
    await handle.terminate("synthetic fixture complete");
    supervisorTurnMode = "SKIP";
    await recordHistory(handle, "room-supervisor-current-signals");
  });

  it("runs pre-patch roomAgentSupervisorWorkflow execution without phase-1 signals", async () => {
    const item = { missionId: "mission:synthetic-pre-patch", turn: { ...roomTurn, agentRunId: "run:pre-patch-synthetic" } };
    const legacyInput = roomAgentSupervisorInputSchema.parse({ roomId: roomTurn.roomId, pending: [item] });
    const finishesBeforeLegacy = calls.get("markRoomAgentMissionFinished") ?? 0;
    const legacy = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: LEGACY_QUEUE, workflowId: "room-supervisor-legacy-synthetic", args: [legacyInput]
    });
    await vi.waitFor(() => expect(calls.get("markRoomAgentMissionStarted") ?? 0).toBeGreaterThan(finishesBeforeLegacy));
    await vi.waitFor(() => expect(calls.get("markRoomAgentMissionFinished") ?? 0).toBeGreaterThan(finishesBeforeLegacy));
    await legacy.terminate("synthetic fixture complete");
    await recordHistory(legacy, "room-supervisor-pre-patch");
  });

  it("rolls over supervisor with continue-as-new after 50 processed items for both current and pre-patch branches", async () => {
    // Current branch: processedCount 49 with 2 items rolls over when reaching 50 processed items
    const item = { missionId: "mission:carry-synthetic-1", turn: { ...roomTurn, agentRunId: "run:carry-synthetic-1" } };
    const nextItem = { missionId: "mission:carry-synthetic-2", turn: { ...roomTurn, agentRunId: "run:carried-synthetic" } };
    const carry = roomAgentSupervisorInputSchema.parse({ roomId: roomTurn.roomId, pending: [item, nextItem], processedCount: 49 });
    const checksBeforeCarry = calls.get("checkRoomAgentSupervisorTurn") ?? 0;
    const carryHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: TASK_QUEUE, workflowId: "room-supervisor-carry-synthetic", args: [carry]
    });
    const originalCarryRun = env.client.workflow.getHandle("room-supervisor-carry-synthetic", carryHandle.firstExecutionRunId);
    await vi.waitFor(() => expect(calls.get("checkRoomAgentSupervisorTurn")).toBeGreaterThan(checksBeforeCarry));
    await vi.waitFor(() => expect(checkedSupervisorTurns).toContain("run:carried-synthetic"));
    expect(checkedSupervisorTurns.filter(runId => runId === "run:carried-synthetic")).toHaveLength(1);
    const carriedHistory = await originalCarryRun.fetchHistory() as { events: Array<{ eventType: number }> };
    expect(carriedHistory.events.some(event => event.eventType === proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW)).toBe(true);
    await env.client.workflow.getHandle("room-supervisor-carry-synthetic").terminate("synthetic fixture complete");
    await recordHistory(originalCarryRun, "room-supervisor-current-continue-as-new");

    // Pre-patch branch: 51 items rollover after 50 items, carries 51st item, preserves monitoringMissionIds, resets processedCount to 0
    const finishCountBeforeLegacyCarry = calls.get("markRoomAgentMissionFinished") ?? 0;
    const finishedIdsBeforeLegacyCarry = finishedLegacyMissionIds.length;
    const legacyMonitoringId = "mission:legacy-monitoring-carry";
    const legacyCarryItems = Array.from({ length: 51 }, (_, index) => ({
      missionId: `mission:legacy-carry-${index}`,
      turn: { ...roomTurn, agentRunId: `run:legacy-carry-${index}` }
    }));
    const legacyCarryInput = roomAgentSupervisorInputSchema.parse({
      roomId: roomTurn.roomId,
      pending: legacyCarryItems,
      processedCount: 0,
      monitoringMissionIds: [legacyMonitoringId]
    });
    const legacyCarryHandle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: LEGACY_QUEUE,
      workflowId: "room-supervisor-legacy-carry-synthetic",
      args: [legacyCarryInput]
    });
    const legacyCarryFirstRun = env.client.workflow.getHandle("room-supervisor-legacy-carry-synthetic", legacyCarryHandle.firstExecutionRunId);
    await vi.waitFor(() => expect((calls.get("markRoomAgentMissionFinished") ?? 0) - finishCountBeforeLegacyCarry).toBeGreaterThanOrEqual(51), { timeout: 30_000 });
    const legacyFirstRunHistory = await legacyCarryFirstRun.fetchHistory() as { events: Array<{
      eventType: number;
      workflowExecutionContinuedAsNewEventAttributes?: { input?: { payloads?: Array<{ data: Uint8Array }> } };
    }> };
    const legacyContinued = legacyFirstRunHistory.events.find(
      event => event.eventType === proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW
    );
    expect(legacyContinued).toBeDefined();
    const legacyCarryPayload = legacyContinued?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0]?.data;
    expect(legacyCarryPayload).toBeDefined();
    const legacyCarryNextInput = JSON.parse(Buffer.from(legacyCarryPayload!).toString("utf8")) as {
      pending: Array<{ missionId: string }>;
      monitoringMissionIds: string[];
      processedCount: number;
    };
    expect(legacyCarryNextInput.pending).toHaveLength(1);
    expect(legacyCarryNextInput.pending[0]?.missionId).toBe("mission:legacy-carry-50");
    expect(legacyCarryNextInput.monitoringMissionIds).toEqual([legacyMonitoringId]);
    expect(legacyCarryNextInput.processedCount).toBe(0);
    const finishedLegacyCarryIds = finishedLegacyMissionIds.slice(finishedIdsBeforeLegacyCarry);
    expect(finishedLegacyCarryIds).toHaveLength(51);
    expect(new Set(finishedLegacyCarryIds)).toEqual(new Set(legacyCarryItems.map(item => item.missionId)));
    await recordHistory(legacyCarryFirstRun, "room-supervisor-pre-patch-continue-as-new");
    await env.client.workflow.getHandle("room-supervisor-legacy-carry-synthetic").terminate("synthetic fixture complete");
  }, 60_000);

  it("supervises allocation, action submission and verification through a prepared continuation", async () => {
    const missionId = "mission:allocated-turn";
    const runId = "run:allocated-turn";
    const preparedTurn = {
      ...roomTurn,
      agentRunId: runId,
      roomAgentContinuation: {
        roomId: roomTurn.roomId,
        missionId,
        actionId: "action:allocated-send",
        idempotencyKey: "send-key",
        actionType: "SEND"
      }
    };
    const input = roomAgentSupervisorInputSchema.parse({
      roomId: roomTurn.roomId,
      monitoringMissionIds: [missionId]
    });
    supervisorPrepareMode = "READY-ONCE";
    supervisorPreparedItem = { missionId, turn: preparedTurn };
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: TASK_QUEUE,
      workflowId: "room-supervisor-allocated-synthetic",
      args: [input]
    });
    await vi.waitFor(() => expect(checkedSupervisorTurns).toContain(runId), { timeout: 30_000 });
    const checked = checkedSupervisorItems.find(item => item.turn.agentRunId === runId);
    expect(checked?.turn.roomAgentContinuation).toMatchObject({ actionId: "action:allocated-send" });
    await handle.terminate("synthetic fixture complete");
  }, 60_000);

  it("cancels an active real child workflow when its mission is stopped", async () => {
    turnActivityResults.push({ status: "COMPLETED", message: "first completed" });
    const runId = "run:child-cancel-synthetic";
    const missionId = "mission:child-cancel";
    const turn = { ...roomTurn, agentRunId: runId };
    let releaseGate: () => void;
    turnActivityGate = {
      started: () => {},
      wait: new Promise<void>(resolve => { releaseGate = resolve; })
    };
    const gateStarted = new Promise<void>(resolve => {
      turnActivityGate!.started = resolve;
    });
    supervisorTurnMode = "ACTIVE";
    const input = roomAgentSupervisorInputSchema.parse({ roomId: roomTurn.roomId, pending: [{ missionId, turn }] });
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: TASK_QUEUE,
      workflowId: "room-supervisor-cancel-child-synthetic",
      args: [input]
    });
    try {
      await gateStarted;
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId, reason: "Operator cancelled active mission" });
      await vi.waitFor(() => expect(finishedSupervisorTurns.some(entry =>
        (entry.item as { missionId: string }).missionId === missionId &&
        entry.status === "INTERRUPTED" &&
        entry.statusReason === "Operator cancelled active mission"
      )).toBe(true), { timeout: 30_000 });
    } finally {
      releaseGate!();
      turnActivityGate = undefined;
      supervisorTurnMode = "SKIP";
      await handle.terminate("synthetic fixture complete");
    }
  }, 60_000);

  it("retires prepared continuations superseded by stop and operator follow-up signals", async () => {
    const signals = ["stop", "follow-up"] as const;
    for (const signalKind of signals) {
      const missionId = `mission:superseded-${signalKind}`;
      const preparedRunId = `run:superseded-prepared-${signalKind}`;
      const followUpRunId = `run:superseded-follow-up-${signalKind}`;
      supervisorPrepareMode = "READY-GATED";
      supervisorPreparedItem = {
        missionId,
        turn: { ...roomTurn, agentRunId: preparedRunId, roomAgentOperatorRequest: "Initial request" }
      };
      const input = roomAgentSupervisorInputSchema.parse({ roomId: roomTurn.roomId, monitoringMissionIds: [missionId] });
      const prepareGate = new Promise<void>(resolve => { supervisorPrepareStarted = resolve; });
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue: TASK_QUEUE,
        workflowId: `room-supervisor-superseded-${signalKind}-synthetic`,
        args: [input]
      });
      try {
        await prepareGate;
        if (signalKind === "stop") {
          await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId, reason: "Superseded by stop" });
        } else {
          await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, {
            missionId,
            turn: { ...roomTurn, agentRunId: followUpRunId, roomAgentOperatorRequest: "Follow-up override" }
          });
        }
        supervisorPrepareResume?.();
        await vi.waitFor(() => expect(discardedSupervisorTurns.some(record =>
          (record.item as { turn: { agentRunId: string } }).turn.agentRunId === preparedRunId
        )).toBe(true), { timeout: 30_000 });
        if (signalKind === "follow-up") {
          await vi.waitFor(() => expect(checkedSupervisorTurns).toContain(followUpRunId), { timeout: 30_000 });
        }
      } finally {
        supervisorPrepareResume?.();
        supervisorPrepareStarted = undefined;
        supervisorPreparedItem = undefined;
        await handle.terminate("synthetic fixture complete");
      }
    }
    supervisorPrepareMode = "DONE";
  }, 60_000);

  it("defers continuation until queued state fits the next run input limit", async () => {
    const missionId = "mission:poll-overflow";
    const initial = { missionId, turn: { ...roomTurn, agentRunId: "run:poll-overflow-0" } };
    const enqueued = { value: false };
    const checkedBefore = calls.get("checkRoomAgentSupervisorTurn") ?? 0;
    const input = roomAgentSupervisorInputSchema.parse({ roomId: roomTurn.roomId, pending: [initial], processedCount: 49 });
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      taskQueue: TASK_QUEUE, workflowId: "room-supervisor-overflow-synthetic", args: [input]
    });
    const firstRun = env.client.workflow.getHandle("room-supervisor-overflow-synthetic", handle.firstExecutionRunId);
    onSupervisorCheck = async item => {
      if (enqueued.value || item.turn.agentRunId !== "run:poll-overflow-0") return;
      enqueued.value = true;
      for (let index = 0; index < 105; index += 1) {
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, {
          missionId,
          turn: { ...roomTurn, agentRunId: `run:poll-overflow-${index + 1}` }
        });
      }
    };
    try {
      await vi.waitFor(async () => {
        const history = await firstRun.fetchHistory() as { events: Array<{ eventType: number }> };
        expect(history.events.some(event => event.eventType === proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW)).toBe(true);
      }, { timeout: 30_000 });
      expect((calls.get("checkRoomAgentSupervisorTurn") ?? 0) - checkedBefore).toBe(6);
      const carried = continuedAsNewInput(await firstRun.fetchHistory()) as { pending: Array<{ turn: { agentRunId: string } }> };
      expect(carried.pending).toHaveLength(100);
      expect(carried.pending[0]?.turn.agentRunId).toBe("run:poll-overflow-6");
      expect(carried.pending.at(-1)?.turn.agentRunId).toBe("run:poll-overflow-105");
    } finally {
      onSupervisorCheck = undefined;
      await handle.terminate("synthetic fixture complete");
    }
  }, 60_000);

  it("continues the selected supervisor branch after 250 polls with monitoring state intact", async () => {
    const branches = ["current", "pre-patch"] as const;
    for (const branch of branches) {
      const isLegacy = branch === "pre-patch";
      if (isLegacy) legacySettleResult = false;
      else supervisorPrepareMode = "WAIT";
      const activityName = isLegacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
      const before = calls.get(activityName) ?? 0;
      const queue = isLegacy ? LEGACY_QUEUE : TASK_QUEUE;
      const id = `room-supervisor-${branch}-polls-synthetic`;
      const missionId = `mission:poll-${branch}`;
      const input = roomAgentSupervisorInputSchema.parse({ roomId: roomTurn.roomId, monitoringMissionIds: [missionId] });
      const pollEnvironment = await TestWorkflowEnvironment.createTimeSkipping({ client: { identity: "synthetic-worker" } });
      const pollWorker = await Worker.create({
        connection: pollEnvironment.nativeConnection,
        taskQueue: queue,
        workflowsPath,
        activities,
        identity: "synthetic-worker",
        ...(isLegacy ? { patchActivationCallback: () => false } : {})
      });
      const pollWorkerRun = pollWorker.run();
      try {
        const handle = await pollEnvironment.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id, args: [input] });
        const firstRun = pollEnvironment.client.workflow.getHandle(id, handle.firstExecutionRunId);
        await pollEnvironment.sleep("300 seconds");
        await vi.waitFor(() => expect((calls.get(activityName) ?? 0) - before).toBeGreaterThanOrEqual(250), { timeout: 120_000 });
        const history = await firstRun.fetchHistory() as { events: Array<{
          eventType: number;
          workflowExecutionContinuedAsNewEventAttributes?: { input?: { payloads?: Array<{ data: Uint8Array }> } };
        }> };
        const continued = history.events.find(event => event.eventType === proto.temporal.api.enums.v1.EventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW);
        expect(continued).toBeDefined();
        const payload = continued?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0]?.data;
        expect(payload).toBeDefined();
        const carriedInput = JSON.parse(Buffer.from(payload!).toString("utf8")) as { monitoringMissionIds: string[] };
        expect(carriedInput.monitoringMissionIds).toContain(missionId);
        await recordHistory(firstRun, `room-supervisor-${branch}-250-polls`);
        await pollEnvironment.client.workflow.getHandle(id).terminate("synthetic fixture complete");
      } finally {
        pollWorker.shutdown();
        await Promise.allSettled([pollWorkerRun]);
        await pollEnvironment.teardown();
      }
    }
  }, 120_000);

  it("replays every checked-in synthetic history and rejects a deliberately nondeterministic workflow", async () => {
    const fixtureFiles = (await readdir(historyDirectory)).filter(name => name.endsWith(".json")).sort();
    expect(fixtureFiles.length).toBeGreaterThanOrEqual(8);
    const fixtures = await Promise.all(fixtureFiles.map(async file => {
      const fixture = JSON.parse(await readFile(join(historyDirectory, file), "utf8"));
      return {
        file,
        workflowId: fixture.workflowId,
        history: proto.temporal.api.history.v1.History.fromObject(fixture.history)
      };
    }));
    const histories = fixtures.map(({ workflowId, history }) => ({ workflowId, history }));
    const fixtureByWorkflowId = new Map(fixtures.map(({ file, workflowId }) => [workflowId, file]));
    const replayResults = [];
    for await (const result of Worker.runReplayHistories({ workflowsPath }, histories)) replayResults.push(result);
    expect(replayResults).toHaveLength(histories.length);
    for (const result of replayResults) {
      const fixture = fixtureByWorkflowId.get(result.workflowId) ?? "unknown fixture";
      expect(result.error, `replay failed for ${result.workflowId} in ${fixture}`).toBeUndefined();
    }

    // Negative verification 1: Generic test-only workflow with an added timer fails with DeterminismViolationError
    const baselinePath = fileURLToPath(new URL("./replay-negative/recording-workflows.ts", import.meta.url));
    const worker = await Worker.create({
      connection: env.nativeConnection, taskQueue: "workflow-replay-negative-fixture",
      workflowsPath: baselinePath, activities: { recordReplayFixtureActivity: async () => "synthetic" },
      identity: "synthetic-worker"
    });
    const running = worker.run();
    const fixtureHandle = await env.client.workflow.start("replayDeterminismFixtureWorkflow", {
      taskQueue: "workflow-replay-negative-fixture", workflowId: "nondeterminism-negative-synthetic"
    });
    await fixtureHandle.result();
    const negativeHistory = await fixtureHandle.fetchHistory();
    worker.shutdown();
    await running;
    const changedPath = fileURLToPath(new URL("./replay-negative/changed-workflows.ts", import.meta.url));
    const negativeResults = [];
    for await (const result of Worker.runReplayHistories({ workflowsPath: changedPath }, [{ workflowId: "nondeterminism-negative-synthetic", history: negativeHistory }])) negativeResults.push(result);
    expect(negativeResults).toHaveLength(1);
    expect(negativeResults[0]?.error).toBeInstanceOf(DeterminismViolationError);

    // Negative verification 2: Explicitly verify dotGoalWorkflow fails replay when an extra timer is introduced
    const changedDotGoalPath = fileURLToPath(new URL("./replay-negative/changed-dot-goal.ts", import.meta.url));
    const dotGoalWakeFixture = fixtures.find(f => f.file === "dot-goal-wake.json");
    expect(dotGoalWakeFixture, "dot-goal-wake.json fixture must be present for determinism check").toBeDefined();
    const dotGoalResults = [];
    for await (const result of Worker.runReplayHistories({ workflowsPath: changedDotGoalPath }, [{ workflowId: dotGoalWakeFixture!.workflowId, history: dotGoalWakeFixture!.history }])) {
      dotGoalResults.push(result);
    }
    expect(dotGoalResults).toHaveLength(1);
    expect(dotGoalResults[0]?.error).toBeInstanceOf(DeterminismViolationError);
  }, 60_000);
});
