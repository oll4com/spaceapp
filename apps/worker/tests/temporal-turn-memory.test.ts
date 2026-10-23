import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DummyTurnInput, MemoryConsolidationRun, MemoryMaintenanceResult, MemoryMutationWorkflowResult } from "@space/contracts";
import { history, withSandbox } from "./support/temporal-sandbox.js";

const turn: DummyTurnInput = {
  roomId: "room:temporal", paneId: "pane:temporal", prompt: "Inspect the test fixture",
  artifactIds: [], permissionMode: null, collaborationMode: "default", traceId: "trace:temporal"
};
const turnResult = {
  workflowId: "turn:fixture", roomId: "room:temporal", paneId: "pane:temporal",
  traceId: "trace:temporal", status: "COMPLETED", message: "The fixture was inspected."
};
const maintenanceInput = { scheduledAt: "2026-10-01T00:00:00.000Z", traceId: "trace:memory" };
const snapshot: MemoryMaintenanceResult = {
  status: "REFRESHED", generatedAt: "2026-10-01T00:00:01.000Z", sourceHash: "a".repeat(64),
  previousSourceHash: null,
  summary: { sourceCount: 1, recordCount: 2, nodeCount: 2, edgeCount: 1, issueCount: 0 }, durationMs: 12
};
const mutationResult: MemoryMutationWorkflowResult = {
  status: "APPLIED", changeSetId: "change:fixture", resultingSourceHash: "b".repeat(64), reason: null
};
function consolidationRun(workflowId: string, overrides: Partial<MemoryConsolidationRun> = {}): MemoryConsolidationRun {
  return {
    id: "run:fixture", mode: "REPAIR", triggerKind: "SCHEDULED", status: "SUCCEEDED", workflowId,
    dedupeKey: "scheduled:fixture", sourceHash: "a".repeat(64), actorUserId: null,
    progressCompleted: 1, progressTotal: 1, findingCount: 1, appliedOperationCount: 1,
    skippedOperationCount: 0, failedOperationCount: 0, metrics: {}, modelId: null,
    aiVerified: false, aiEvidence: {}, statusReason: null,
    createdAt: "2026-10-01T00:00:00.000Z", startedAt: "2026-10-01T00:00:01.000Z",
    completedAt: "2026-10-01T00:00:02.000Z", updatedAt: "2026-10-01T00:00:02.000Z",
    ...overrides
  };
}
const bridge = {
  roomId: "room:temporal", missionId: "mission:temporal", agentPaneId: "pane:temporal",
  agentSessionId: "session:temporal", selectedToolIds: ["room:restart"], backgroundExecution: true,
  actions: [{ toolId: "room:restart", action: { type: "restart", paneId: "pane:target" } }]
};
const memoryQueues = ["space-memory-maintenance", "space-memory-mutations"];

describe("turn and memory workflows in the Temporal sandbox", () => {
  let env: TestWorkflowEnvironment;
  beforeAll(async () => { env = await TestWorkflowEnvironment.createTimeSkipping(); }, 120_000);
  afterAll(async () => { await env?.teardown(); }, 30_000);

  // Catches completion being scheduled before a failed start is durably retried.
  it("retries the dummy start before completing the turn", async () => {
    const calls: Array<{ name: string; attempt: number; input: unknown }> = [];
    await withSandbox({ environment: env, activities: {
      recordDummyTurnStarted: async (input: unknown) => {
        const attempt = Context.current().info.attempt;
        calls.push({ name: "started", attempt, input });
        if (attempt === 1) throw new Error("temporary store outage");
        return { workflowId: "turn:fixture" };
      },
      recordDummyTurnCompleted: async (input: unknown) => {
        calls.push({ name: "completed", attempt: Context.current().info.attempt, input });
        return turnResult;
      }
    } }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start("dummyTurnWorkflow", {
        workflowId: `dummy-${randomUUID()}`, taskQueue, args: [turn]
      });
      expect(await handle.result()).toEqual(turnResult);
      expect(calls).toEqual([
        { name: "started", attempt: 1, input: turn },
        { name: "started", attempt: 2, input: turn },
        { name: "completed", attempt: 1, input: turn }
      ]);
      await record(handle, "temporal-turn-memory-dummy-retry");
    });
  }, 60_000);

  it("never completes the dummy turn when all start attempts fail", async () => {
    const attempts: number[] = [];
    await withSandbox({ environment: env, activities: {
      recordDummyTurnStarted: async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("store remains unavailable");
      },
      recordDummyTurnCompleted: async () => turnResult
    } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("dummyTurnWorkflow", {
        workflowId: `dummy-failed-${randomUUID()}`, taskQueue, args: [turn]
      });
      await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "store remains unavailable" } } });
      expect(attempts).toEqual([1, 2, 3]);
      const h = await history(handle);
      expect(h.events?.flatMap((event) => event.activityTaskScheduledEventAttributes?.activityType?.name ?? [])).toEqual(["recordDummyTurnStarted"]);
    });
  }, 60_000);

  // Catches routing a provider to the wrong runtime and accidentally shortening native Chats to the room limit.
  it.each([
    { label: "opencode", input: { ...turn, providerId: "opencode" }, activity: "runOpenCodeAgentTurn", timeout: 2400, attempts: 1 },
    { label: "cli", input: { ...turn, providerId: "cli:claude" }, activity: "runCliAgentTurn", timeout: 1800, attempts: 1 },
    { label: "native-chat", input: { ...turn, providerId: "codex", agentSessionId: "session:chat", agentAssistantMessageId: "message:answer" }, activity: "runCodexAppServerTurn", timeout: null, attempts: 5 },
    { label: "room-mission", input: { ...turn, providerId: "codex", agentSessionId: "session:chat", agentAssistantMessageId: "message:answer", roomAgentMissionId: "mission:room" }, activity: "runCodexAppServerTurn", timeout: 86400, attempts: 5 }
  ])("routes $label with its execution budget and returns the activity result", async ({ label, input, activity, timeout, attempts }) => {
    await withSandbox({ environment: env, activities: {
      [activity]: async (received: unknown) => ({ ...turnResult, message: JSON.stringify(received) })
    } }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start("codexAppServerTurnWorkflow", {
        workflowId: `turn-${label}-${randomUUID()}`, taskQueue, args: [input]
      });
      expect(await handle.result()).toEqual({ ...turnResult, message: JSON.stringify(input) });
      const h = await history(handle);
      const scheduled = h.events?.flatMap((event) => event.activityTaskScheduledEventAttributes ?? []) ?? [];
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]?.activityType?.name).toBe(activity);
      // Temporal bounds a requested duration by the workflow's own execution
      // horizon (the test server caps it at ten years). The contract is that a
      // native Chat is not cut off by the finite room/CLI activity budgets.
      const scheduledSeconds = Number(scheduled[0]?.startToCloseTimeout?.seconds);
      if (timeout === null) expect(scheduledSeconds).toBeGreaterThanOrEqual(365 * 86400);
      else expect(scheduledSeconds).toBe(timeout);
      expect(scheduled[0]?.retryPolicy?.maximumAttempts).toBe(attempts);
      await record(handle, `temporal-turn-memory-${label}`);
    });
  }, 60_000);

  it.each(["opencode", "cli:claude"])("does not repeat a failed single-attempt %s turn", async (providerId) => {
    const attempts: number[] = [];
    const activity = providerId === "opencode" ? "runOpenCodeAgentTurn" : "runCliAgentTurn";
    await withSandbox({ environment: env, activities: {
      [activity]: async () => { attempts.push(Context.current().info.attempt); throw new Error("provider connection lost"); }
    } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("codexAppServerTurnWorkflow", {
        workflowId: `provider-failed-${randomUUID()}`, taskQueue, args: [{ ...turn, providerId }]
      });
      await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "provider connection lost" } } });
      expect(attempts).toEqual([1]);
    });
  }, 60_000);

  // Catches losing durable failure cleanup, or updating the wrong action for histories without actionId.
  it.each([true, false])("marks an exhausted action failed (explicit action id: %s) and preserves its failure", async (explicit) => {
    const attempts: number[] = [];
    const failures: unknown[] = [];
    const workflowId = `space-room-action:legacy-${randomUUID()}`;
    const input = { bridge, traceId: "trace:action", ...(explicit ? { actionId: "action:explicit" } : {}) };
    await withSandbox({ environment: env, activities: {
      runRoomAgentBackgroundAction: async () => {
        attempts.push(Context.current().info.attempt);
        throw new Error("background action failed");
      },
      failRoomAgentBackgroundAction: async (failed: unknown) => { failures.push(failed); }
    } }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start("roomAgentActionWorkflow", { workflowId, taskQueue, args: [input] });
      await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "background action failed" } } });
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      expect(failures).toEqual([{
        roomId: "room:temporal", missionId: "mission:temporal",
        actionId: explicit ? "action:explicit" : workflowId.slice("space-room-action:".length), cancelled: false
      }]);
      const h = await history(handle);
      expect(h.events?.some((event) => event.markerRecordedEventAttributes?.markerName === "core_patch")).toBe(true);
      await record(handle, explicit ? "temporal-turn-memory-action-failed" : "temporal-turn-memory-action-legacy-id");
    });
  }, 60_000);

  it("returns a successful action without scheduling failure cleanup", async () => {
    const response = { id: "space-agent-room-action-bridge", results: [{
      request: bridge.actions[0], status: "EXECUTED", statusReason: "Pane restarted.",
      paneId: "pane:target", missionId: "mission:temporal", evidence: { restarted: true }
    }] };
    await withSandbox({ environment: env, activities: { runRoomAgentBackgroundAction: async () => response } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("roomAgentActionWorkflow", {
        workflowId: `action-success-${randomUUID()}`, taskQueue,
        args: [{ actionId: "action:success", bridge, traceId: "trace:action" }]
      });
      expect(await handle.result()).toEqual(response);
      const h = await history(handle);
      expect(h.events?.flatMap((event) => event.activityTaskScheduledEventAttributes?.activityType?.name ?? [])).toEqual(["runRoomAgentBackgroundAction"]);
    });
  }, 60_000);

  // Catches either optional refresh becoming fatal, omitting consolidation, or starting its child on the wrong queue.
  it("continues after both optional maintenance activities exhaust retries and waits for its real consolidation child", async () => {
    const childId = `memory-child-${randomUUID()}`;
    const run = consolidationRun(childId, { mode: "AUDIT", appliedOperationCount: 0 });
    const calls: Array<{ name: string; attempt: number; input: unknown }> = [];
    const activity = (name: string, result: unknown, fail = false) => async (input: unknown) => {
      calls.push({ name, attempt: Context.current().info.attempt, input });
      if (fail) throw new Error(`${name} unavailable`);
      return result;
    };
    await withSandbox({ environment: env, taskQueues: memoryQueues, activities: {
      refreshMemoryGraphSnapshot: activity("live", snapshot),
      refreshAllMonthsMemoryGraphSnapshot: activity("all-months", null, true),
      reconcileStaleSpaceAgentSessions: activity("sessions", null, true),
      createScheduledMemoryAudit: activity("audit", run),
      prepareMemoryConsolidation: activity("prepare", { run, changeSetId: null })
    } }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start("memoryMaintenanceWorkflow", {
        workflowId: `maintenance-${randomUUID()}`, taskQueue, args: [maintenanceInput]
      });
      expect(await handle.result()).toEqual(snapshot);
      expect(calls.map(({ name, attempt }) => [name, attempt])).toEqual([
        ["live", 1], ["all-months", 1], ["all-months", 2], ["all-months", 3],
        ["sessions", 1], ["sessions", 2], ["sessions", 3], ["audit", 1], ["prepare", 1]
      ]);
      expect(calls.find((call) => call.name === "audit")?.input).toEqual({ ...maintenanceInput, sourceHash: "a".repeat(64) });
      expect(calls.find((call) => call.name === "prepare")?.input).toEqual({ runId: "run:fixture", traceId: "trace:memory" });
      const h = await history(handle);
      const child = h.events?.find((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)?.startChildWorkflowExecutionInitiatedEventAttributes;
      expect(child?.workflowType?.name).toBe("memoryConsolidationWorkflow");
      expect(child?.workflowId).toBe(childId);
      expect(child?.taskQueue?.name).toBe("space-memory-maintenance");
      expect(h.events?.some((event) => event.childWorkflowExecutionCompletedEventAttributes)).toBe(true);
      await record(handle, "temporal-turn-memory-maintenance-fallbacks");
      await record(client.workflow.getHandle(childId), "temporal-turn-memory-consolidation-child");
    });
  }, 60_000);

  it("does not start an audit when the required live snapshot fails", async () => {
    const attempts: number[] = [];
    await withSandbox({ environment: env, activities: {
      refreshMemoryGraphSnapshot: async () => { attempts.push(Context.current().info.attempt); throw new Error("live graph unavailable"); }
    } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("memoryMaintenanceWorkflow", {
        workflowId: `maintenance-failed-${randomUUID()}`, taskQueue, args: [maintenanceInput]
      });
      await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "live graph unavailable" } } });
      expect(attempts).toEqual([1, 2, 3]);
      const h = await history(handle);
      expect(h.events?.flatMap((event) => event.activityTaskScheduledEventAttributes?.activityType?.name ?? [])).toEqual(["refreshMemoryGraphSnapshot"]);
      expect(h.events?.some((event) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
    });
  }, 60_000);

  it("returns a consolidation with no change set without invoking the mutation worker", async () => {
    const run = consolidationRun(`audit-${randomUUID()}`, { mode: "AUDIT", appliedOperationCount: 0 });
    await withSandbox({ environment: env, activities: {
      prepareMemoryConsolidation: async () => ({ run, changeSetId: null })
    } }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start("memoryConsolidationWorkflow", {
        workflowId: run.workflowId, taskQueue, args: [{ runId: run.id, traceId: "trace:audit" }]
      });
      expect(await handle.result()).toEqual(run);
      const h = await history(handle);
      expect(h.events?.flatMap((event) => event.activityTaskScheduledEventAttributes?.activityType?.name ?? [])).toEqual(["prepareMemoryConsolidation"]);
      await record(handle, "temporal-turn-memory-consolidation-no-change");
    });
  }, 60_000);

  // Catches mutation/finalization reordering, lost mutation results, and dropping either activity's retry policy.
  it("retries a repair on the mutation queue and finalizes exactly that change set", async () => {
    const run = consolidationRun(`repair-${randomUUID()}`);
    const calls: Array<{ name: string; attempt: number; input: unknown; queue: string }> = [];
    const recordCall = (name: string, input: unknown) => {
      const { attempt, taskQueue } = Context.current().info;
      calls.push({ name, attempt, input, queue: taskQueue });
      return attempt;
    };
    await withSandbox({ environment: env, taskQueues: memoryQueues, activities: {
      prepareMemoryConsolidation: async (input: unknown) => {
        if (recordCall("prepare", input) === 1) throw new Error("temporary read failure");
        return { run, changeSetId: "change:fixture" };
      },
      executePersistedMemoryChangeSet: async (input: unknown) => {
        if (recordCall("mutate", input) === 1) throw new Error("temporary journal lock");
        return mutationResult;
      },
      finalizeMemoryRepair: async (input: unknown) => {
        if (recordCall("finalize", input) === 1) throw new Error("temporary result-store outage");
        return run;
      }
    } }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start("memoryConsolidationWorkflow", {
        workflowId: run.workflowId, taskQueue, args: [{ runId: run.id, traceId: "trace:repair" }]
      });
      expect(await handle.result()).toEqual(run);
      expect(calls.map(({ name, attempt }) => [name, attempt])).toEqual([
        ["prepare", 1], ["prepare", 2], ["mutate", 1], ["mutate", 2], ["finalize", 1], ["finalize", 2]
      ]);
      expect(calls.filter((call) => call.name === "mutate").map(({ input, queue }) => ({ input, queue }))).toEqual([
        { input: { changeSetId: "change:fixture", traceId: "trace:repair" }, queue: "space-memory-mutations" },
        { input: { changeSetId: "change:fixture", traceId: "trace:repair" }, queue: "space-memory-mutations" }
      ]);
      expect(calls.filter((call) => call.name === "finalize").map((call) => call.input)).toEqual([
        { runId: "run:fixture", changeSetId: "change:fixture", mutationResult },
        { runId: "run:fixture", changeSetId: "change:fixture", mutationResult }
      ]);
      await record(handle, "temporal-turn-memory-consolidation-repair");
    });
  }, 60_000);

  it("does not finalize a repair whose mutation exhausts retries", async () => {
    const run = consolidationRun(`repair-failed-${randomUUID()}`);
    const attempts: number[] = [];
    await withSandbox({ environment: env, taskQueues: memoryQueues, activities: {
      prepareMemoryConsolidation: async () => ({ run, changeSetId: "change:fixture" }),
      executePersistedMemoryChangeSet: async () => { attempts.push(Context.current().info.attempt); throw new Error("journal unavailable"); }
    } }, async ({ client, taskQueue }) => {
      const handle = await client.workflow.start("memoryConsolidationWorkflow", {
        workflowId: run.workflowId, taskQueue, args: [{ runId: run.id, traceId: "trace:repair" }]
      });
      await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { message: "journal unavailable" } } });
      expect(attempts).toEqual([1, 2, 3]);
      const h = await history(handle);
      expect(h.events?.flatMap((event) => event.activityTaskScheduledEventAttributes?.activityType?.name ?? [])).toEqual([
        "prepareMemoryConsolidation", "executePersistedMemoryChangeSet"
      ]);
    });
  }, 60_000);

  it("returns a mutation result after a transient activity failure", async () => {
    const attempts: Array<{ attempt: number; input: unknown }> = [];
    await withSandbox({ environment: env, activities: {
      executePersistedMemoryChangeSet: async (input: unknown) => {
        const attempt = Context.current().info.attempt;
        attempts.push({ attempt, input });
        if (attempt === 1) throw new Error("journal lock busy");
        return mutationResult;
      }
    } }, async ({ client, taskQueue, record }) => {
      const input = { changeSetId: "change:fixture", traceId: "trace:mutation" };
      const handle = await client.workflow.start("memoryMutationWorkflow", { workflowId: `mutation-${randomUUID()}`, taskQueue, args: [input] });
      expect(await handle.result()).toEqual(mutationResult);
      expect(attempts).toEqual([{ attempt: 1, input }, { attempt: 2, input }]);
      await record(handle, "temporal-turn-memory-mutation-retry");
    });
  }, 60_000);

  it("propagates a non-retryable mutation error without retrying it", async () => {
    const attempts: number[] = [];
    await withSandbox({ environment: env, activities: {
      executePersistedMemoryChangeSet: async () => {
        attempts.push(Context.current().info.attempt);
        throw ApplicationFailure.nonRetryable("invalid persisted change set", "INVALID_CHANGE_SET");
      }
    } }, async ({ client, taskQueue, record }) => {
      const handle = await client.workflow.start("memoryMutationWorkflow", {
        workflowId: `mutation-invalid-${randomUUID()}`, taskQueue,
        args: [{ changeSetId: "change:invalid", traceId: "trace:mutation" }]
      });
      await expect(handle.result()).rejects.toMatchObject({ cause: { cause: { type: "INVALID_CHANGE_SET", nonRetryable: true } } });
      expect(attempts).toEqual([1]);
      await record(handle, "temporal-turn-memory-mutation-invalid");
    });
  }, 60_000);
});
