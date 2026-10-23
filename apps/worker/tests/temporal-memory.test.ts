import { Context } from "@temporalio/activity";
import type { WorkflowHandle } from "@temporalio/client";
import type { MemoryConsolidationRun, MemoryMaintenanceResult, MemoryMutationWorkflowResult } from "@space/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Sandbox } from "./support/temporal-sandbox.js";

const maintenanceQueue = "space-memory-maintenance";
const mutationQueue = "space-memory-mutations";
const sourceHash = "a".repeat(64);
const resultingHash = "b".repeat(64);
const timestamp = "2026-07-13T03:00:00.000Z";
let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}:${sequence}`;
}

function runFixture(id: string, workflowId = nextId("workflow:memory-child")): MemoryConsolidationRun {
  return {
    id,
    mode: "REPAIR",
    triggerKind: "SCHEDULED",
    status: "QUEUED",
    workflowId,
    dedupeKey: `scheduled:${id}`,
    sourceHash,
    actorUserId: null,
    progressCompleted: 0,
    progressTotal: 0,
    findingCount: 0,
    appliedOperationCount: 0,
    skippedOperationCount: 0,
    failedOperationCount: 0,
    metrics: {},
    modelId: null,
    aiVerified: false,
    aiEvidence: {},
    statusReason: null,
    createdAt: timestamp,
    startedAt: null,
    completedAt: null,
    updatedAt: timestamp
  };
}

const snapshot: MemoryMaintenanceResult = {
  status: "REFRESHED",
  generatedAt: timestamp,
  sourceHash,
  previousSourceHash: null,
  summary: { sourceCount: 2, recordCount: 3, nodeCount: 3, edgeCount: 0, issueCount: 1 },
  durationMs: 7
};

function childStarts(history: Awaited<ReturnType<WorkflowHandle["fetchHistory"]>>) {
  return history.events?.flatMap((event) => {
    const attributes = event.startChildWorkflowExecutionInitiatedEventAttributes;
    return attributes ? [attributes] : [];
  }) ?? [];
}

function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current instanceof Error; depth += 1) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages;
}

describe("memory workflows in a real Temporal sandbox", () => {
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await Sandbox.create();
  }, 60_000);

  afterAll(async () => {
    await sandbox?.close();
  });

  it.each(["all-months refresh", "stale-session reconciliation"])(
    "continues the scheduled audit and child consolidation when %s fails after three attempts",
    async (failedStep) => {
      const input = { scheduledAt: timestamp, traceId: nextId("trace:maintenance") };
      const auditRun = runFixture(nextId("memory_consolidation:scheduled"));
      const calls: Array<{ name: string; input?: unknown; attempt: number }> = [];
      const record = (name: string, activityInput?: unknown) => {
        calls.push({ name, input: activityInput, attempt: Context.current().info.attempt });
      };
      const activities = {
        refreshMemoryGraphSnapshot: async (activityInput: unknown) => {
          record("refresh", activityInput);
          return snapshot;
        },
        refreshAllMonthsMemoryGraphSnapshot: async (activityInput: unknown) => {
          record("allMonths", activityInput);
          if (failedStep === "all-months refresh") throw new Error("synthetic all-months failure");
          return snapshot;
        },
        reconcileStaleSpaceAgentSessions: async () => {
          record("reconcile");
          if (failedStep === "stale-session reconciliation") throw new Error("synthetic reconciliation failure");
          return 0;
        },
        createScheduledMemoryAudit: async (activityInput: unknown) => {
          record("audit", activityInput);
          return auditRun;
        },
        prepareMemoryConsolidation: async (activityInput: unknown) => {
          record("prepare", activityInput);
          return { run: auditRun, changeSetId: null };
        }
      };

      await sandbox.run(activities, async (worker) => {
        const parent = await worker.start("memoryMaintenanceWorkflow", input, {
          workflowId: nextId("workflow:maintenance"), taskQueue: maintenanceQueue
        });
        expect(await parent.result()).toEqual(snapshot);

        expect(calls.filter((call) => call.name === "refresh")).toEqual([{ name: "refresh", input, attempt: 1 }]);
        expect(calls.filter((call) => call.name === "allMonths").map((call) => call.attempt))
          .toEqual(failedStep === "all-months refresh" ? [1, 2, 3] : [1]);
        expect(calls.filter((call) => call.name === "reconcile").map((call) => call.attempt))
          .toEqual(failedStep === "stale-session reconciliation" ? [1, 2, 3] : [1]);
        expect(calls.filter((call) => call.name === "audit")).toEqual([
          { name: "audit", input: { ...input, sourceHash }, attempt: 1 }
        ]);
        expect(calls.filter((call) => call.name === "prepare")).toEqual([
          { name: "prepare", input: { runId: auditRun.id, traceId: input.traceId }, attempt: 1 }
        ]);

        const starts = childStarts(await parent.fetchHistory());
        expect(starts).toHaveLength(1);
        expect(starts[0]).toMatchObject({
          workflowId: auditRun.workflowId,
          workflowType: { name: "memoryConsolidationWorkflow" },
          taskQueue: { name: maintenanceQueue }
        });
        expect(await worker.env.client.workflow.getHandle(auditRun.workflowId).result()).toEqual(auditRun);
      }, { taskQueue: maintenanceQueue });
    },
    30_000
  );

  it("routes a prepared change set to the mutation queue and finalizes with its exact result", async () => {
    const input = { runId: nextId("memory_consolidation:apply"), traceId: nextId("trace:consolidation") };
    const changeSetId = nextId("memory_change_set:apply");
    const preparedRun = runFixture(input.runId);
    const finalizedRun: MemoryConsolidationRun = {
      ...preparedRun,
      status: "SUCCEEDED",
      startedAt: timestamp,
      completedAt: timestamp,
      progressCompleted: 1,
      progressTotal: 1,
      appliedOperationCount: 1
    };
    const mutationResult: MemoryMutationWorkflowResult = {
      status: "APPLIED", changeSetId, resultingSourceHash: resultingHash, reason: null
    };
    const preparedInputs: unknown[] = [];
    const mutationInputs: unknown[] = [];
    const finalizationInputs: unknown[] = [];

    await sandbox.run({
      prepareMemoryConsolidation: async (activityInput: unknown) => {
        preparedInputs.push(activityInput);
        return { run: preparedRun, changeSetId };
      },
      executePersistedMemoryChangeSet: async (activityInput: unknown) => {
        mutationInputs.push(activityInput);
        return mutationResult;
      },
      finalizeMemoryRepair: async (activityInput: unknown) => {
        finalizationInputs.push(activityInput);
        return finalizedRun;
      }
    }, async (worker) => {
      const handle = await worker.start("memoryConsolidationWorkflow", input, {
        workflowId: nextId("workflow:consolidation"), taskQueue: maintenanceQueue
      });
      expect(await handle.result()).toEqual(finalizedRun);
      expect(preparedInputs).toEqual([input]);
      expect(mutationInputs).toEqual([{ changeSetId, traceId: input.traceId }]);
      expect(finalizationInputs).toEqual([{ runId: input.runId, changeSetId, mutationResult }]);

      const scheduled = (await handle.fetchHistory()).events?.flatMap((event) => {
        const attributes = event.activityTaskScheduledEventAttributes;
        return attributes?.activityType?.name === "executePersistedMemoryChangeSet" ? [attributes] : [];
      }) ?? [];
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.taskQueue?.name).toBe(mutationQueue);
    }, { taskQueue: maintenanceQueue, extraTaskQueues: [mutationQueue] });
  });

  it("returns the prepared run without scheduling mutation or finalization when there is no change set", async () => {
    const input = { runId: nextId("memory_consolidation:unchanged"), traceId: nextId("trace:unchanged") };
    const run = runFixture(input.runId);
    const preparedInputs: unknown[] = [];
    let mutationCalls = 0;
    let finalizationCalls = 0;

    await sandbox.run({
      prepareMemoryConsolidation: async (activityInput: unknown) => {
        preparedInputs.push(activityInput);
        return { run, changeSetId: null };
      },
      executePersistedMemoryChangeSet: async () => { mutationCalls += 1; throw new Error("unexpected mutation"); },
      finalizeMemoryRepair: async () => { finalizationCalls += 1; throw new Error("unexpected finalization"); }
    }, async (worker) => {
      const handle = await worker.start("memoryConsolidationWorkflow", input, {
        workflowId: nextId("workflow:no-change"), taskQueue: maintenanceQueue
      });
      expect(await handle.result()).toEqual(run);
      expect(preparedInputs).toEqual([input]);
      expect(mutationCalls).toBe(0);
      expect(finalizationCalls).toBe(0);
      const scheduledNames = (await handle.fetchHistory()).events?.flatMap((event) => {
        const name = event.activityTaskScheduledEventAttributes?.activityType?.name;
        return name ? [name] : [];
      }) ?? [];
      expect(scheduledNames).toEqual(["prepareMemoryConsolidation"]);
    }, { taskQueue: maintenanceQueue, extraTaskQueues: [mutationQueue] });
  });

  it("propagates a consolidation mutation failure after three attempts without finalizing", async () => {
    const input = { runId: nextId("memory_consolidation:fail"), traceId: nextId("trace:consolidation-fail") };
    const changeSetId = nextId("memory_change_set:consolidation-fail");
    const attempts: number[] = [];
    let finalizationCalls = 0;
    await sandbox.run({
      prepareMemoryConsolidation: async () => ({ run: runFixture(input.runId), changeSetId }),
      executePersistedMemoryChangeSet: async (activityInput: unknown) => {
        expect(activityInput).toEqual({ changeSetId, traceId: input.traceId });
        attempts.push(Context.current().info.attempt);
        throw new Error("synthetic consolidation mutation failure");
      },
      finalizeMemoryRepair: async () => { finalizationCalls += 1; throw new Error("unexpected finalization"); }
    }, async (worker) => {
      const handle = await worker.start("memoryConsolidationWorkflow", input, {
        workflowId: nextId("workflow:consolidation-fail"), taskQueue: maintenanceQueue
      });
      const failure = await handle.result().catch((error: unknown) => error);
      expect(errorMessages(failure)).toContain("synthetic consolidation mutation failure");
      expect(attempts).toEqual([1, 2, 3]);
      expect(finalizationCalls).toBe(0);
    }, { taskQueue: maintenanceQueue, extraTaskQueues: [mutationQueue] });
  });

  it("retries a transient mutation twice and returns the third attempt's result", async () => {
    const input = { changeSetId: nextId("memory_change_set:retry"), traceId: nextId("trace:mutation") };
    const attempts: number[] = [];
    const result: MemoryMutationWorkflowResult = {
      status: "APPLIED", changeSetId: input.changeSetId, resultingSourceHash: resultingHash, reason: null
    };
    await sandbox.run({
      executePersistedMemoryChangeSet: async (activityInput: unknown) => {
        expect(activityInput).toEqual(input);
        const attempt = Context.current().info.attempt;
        attempts.push(attempt);
        if (attempt < 3) throw new Error(`synthetic transient mutation failure ${attempt}`);
        return result;
      }
    }, async (worker) => {
      const handle = await worker.start("memoryMutationWorkflow", input, {
        workflowId: nextId("workflow:mutation-retry"), taskQueue: mutationQueue
      });
      expect(await handle.result()).toEqual(result);
      expect(attempts).toEqual([1, 2, 3]);
    }, { taskQueue: mutationQueue });
  });

  it("propagates mutation failure after exactly three activity attempts", async () => {
    const input = { changeSetId: nextId("memory_change_set:fail"), traceId: nextId("trace:mutation-fail") };
    const attempts: number[] = [];
    await sandbox.run({
      executePersistedMemoryChangeSet: async (activityInput: unknown) => {
        expect(activityInput).toEqual(input);
        attempts.push(Context.current().info.attempt);
        throw new Error("synthetic permanent mutation failure");
      }
    }, async (worker) => {
      const handle = await worker.start("memoryMutationWorkflow", input, {
        workflowId: nextId("workflow:mutation-fail"), taskQueue: mutationQueue
      });
      const failure = await handle.result().catch((error: unknown) => error);
      expect(errorMessages(failure)).toContain("synthetic permanent mutation failure");
      expect(attempts).toEqual([1, 2, 3]);
    }, { taskQueue: mutationQueue });
  });
});
