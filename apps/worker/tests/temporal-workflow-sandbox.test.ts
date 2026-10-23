import path from "node:path";
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { ApplicationFailure, defaultPayloadConverter } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import { Worker } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { WorkflowContinuedAsNewError, type WorkflowHandle, type WorkflowHandleWithStartDetails } from "@temporalio/client";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema } from "@space/contracts";
import { actionInput, actionResult, activities, bundle, environment, eventType, here, item, loadHistory,
  maintenanceResult, MEMORY_CONSOLIDATION_TASK_QUEUE, MEMORY_MUTATION_TASK_QUEUE,
  saveHistory, syntheticTime, turn, turnResult, worker } from "./temporal-sandbox-helpers.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";

const names = ["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
  "roomAgentSupervisorWorkflow-pre-patch", "roomAgentActionWorkflow", "memoryMaintenanceWorkflow",
  "memoryConsolidationWorkflow", "memoryMutationWorkflow"];
vi.setConfig({ testTimeout: 30_000, hookTimeout: 90_000 });

describe("real Temporal workflows and replay", () => {
  let env: TestWorkflowEnvironment;
  let bundles: Record<"turns" | "legacy" | "maintenance" | "mutation", Awaited<ReturnType<typeof bundle>>>;
  let sequence = 0;
  let suiteStarted = 0;
  const id = (prefix: string) => `${prefix}-${++sequence}`;

  beforeAll(async () => {
    suiteStarted = performance.now();
    bundles = { turns: await bundle("turns"), legacy: await bundle("turns", true),
      maintenance: await bundle("maintenance"), mutation: await bundle("mutation") };
  }, 90_000);
  // Time skipping is server-global. A cancelled/terminated child in a previous
  // case must not hold the next case's clock or conceal a signal ordering bug.
  beforeEach(async () => { env = await environment(); });
  afterEach(async () => { await env?.teardown(); });
  afterAll(() => { expect(performance.now() - suiteStarted, "Temporal suite must add less than three minutes").toBeLessThan(180_000); });

  async function continued(handle: WorkflowHandleWithStartDetails) {
    const first = env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId, { followRuns: false });
    await expect(first.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
    const history = await first.fetchHistory();
    const last = history.events!.at(-1)!;
    expect(last.eventType).toBe(eventType.EVENT_TYPE_WORKFLOW_EXECUTION_CONTINUED_AS_NEW);
    const attributes = last.workflowExecutionContinuedAsNewEventAttributes!;
    expect(attributes.newExecutionRunId).toBeTruthy();
    const carried: unknown = defaultPayloadConverter.fromPayload(attributes.input!.payloads![0]!);
    return { carried, history, newRunId: attributes.newExecutionRunId! };
  }
  async function cancel(handle: WorkflowHandle) {
    const latest = env.client.workflow.getHandle(handle.workflowId);
    // Test cleanup only. Exercise cancellation via the stop signal in its own test.
    await latest.terminate("Synthetic test cleanup");
    await latest.result().catch(() => {});
  }

  it("records both turn workflows and retries failed dummy activities", async () => {
    const queue = id("turns"); const stubs = activities();
    let starts = 0;
    stubs.recordDummyTurnStarted = async () => {
      if (++starts === 1) throw ApplicationFailure.retryable("synthetic transient failure");
      return { workflowId: "workflow:synthetic" };
    };
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      for (const name of ["dummyTurnWorkflow", "codexAppServerTurnWorkflow"]) {
        const handle = await env.client.workflow.start(name, { taskQueue: queue, workflowId: id(name), args: [turn()] });
        expect(await handle.result()).toMatchObject({ status: "COMPLETED", roomId: turn().roomId });
        await saveHistory(name, await handle.fetchHistory());
      }
      expect(starts).toBe(2);
    });
  });

  it.each(["opencode", "cli:claude", "codex"])("routes %s turns through the real workflow", async providerId => {
    const queue = id("provider"); const stubs = activities(); const calls: string[] = [];
    stubs.runCodexAppServerTurn = async input => { calls.push("codex"); return turnResult(input); };
    stubs.runOpenCodeAgentTurn = async input => { calls.push("opencode"); return turnResult(input); };
    stubs.runCliAgentTurn = async input => { calls.push("cli"); return turnResult(input); };
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      await env.client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue: queue, workflowId: id("route"), args: [{ ...turn(), providerId }] });
      expect(calls).toEqual([providerId === "opencode" ? "opencode" : providerId === "cli:claude" ? "cli" : "codex"]);
    });
  });

  it("propagates a turn failure after configured retries", async () => {
    const queue = id("turn-failure"); const stubs = activities(); let attempts = 0;
    stubs.runCodexAppServerTurn = async () => { attempts++; throw ApplicationFailure.retryable("synthetic failure"); };
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      await expect(env.client.workflow.execute("codexAppServerTurnWorkflow", { taskQueue: queue, workflowId: id("failed-turn"), args: [turn()] })).rejects.toThrow();
      expect(attempts).toBe(5);
    });
  });

  it.each(["wake", "timeout"])("dot goal handles %s using real signal/timer commands", async mode => {
    const queue = id("dot"); const stubs = activities(); let steps = 0;
    stubs.dotGoalStep = async () => (++steps === 1 ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" });
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", { taskQueue: queue, workflowId: id("goal"), args: [{ goalId: "goal:synthetic" }] });
      if (mode === "wake") {
        await vi.waitFor(async () => {
          const history = await handle.fetchHistory();
          expect(history.events!.some(e => e.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString() === "30")).toBe(true);
        }, { timeout: 5_000 });
        await handle.signal(DOT_GOAL_SIGNAL);
      }
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(steps).toBe(2);
      const history = await handle.fetchHistory();
      expect(history.events!.some(e => e.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString() === "30")).toBe(true);
      expect(history.events!.some(e => e.eventType === eventType.EVENT_TYPE_WORKFLOW_EXECUTION_SIGNALED)).toBe(mode === "wake");
      expect(history.events!.some(e => e.eventType === eventType.EVENT_TYPE_TIMER_FIRED)).toBe(mode === "timeout");
      if (mode === "timeout") await saveHistory("dotGoalWorkflow", history);
    });
  });

  it("dot goal records continue-as-new at the 300 iteration bound", async () => {
    const queue = id("dot-bound"); const stubs = activities(); let steps = 0;
    stubs.dotGoalStep = async () => { steps++; return { state: "WAITING", runId: null, goalStatus: "RUNNING" }; };
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      const handle = await env.client.workflow.start("dotGoalWorkflow", { taskQueue: queue, workflowId: id("goal-bound"), args: [{ goalId: "goal:bounded" }] });
      const result = await continued(handle);
      expect(result.carried).toEqual({ goalId: "goal:bounded" });
      expect(result.history.events!.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "dotGoalStep")).toHaveLength(300);
      await cancel(handle);
    });
  }, 60_000);

  it("persists action failure after activity retries and derives a legacy action id", async () => {
    const queue = id("action"); const stubs = activities(); const failure = vi.fn(async (_input: unknown) => {}); let attempts = 0;
    stubs.failRoomAgentBackgroundAction = failure;
    stubs.runRoomAgentBackgroundAction = async () => { attempts++; throw ApplicationFailure.retryable("synthetic action failure"); };
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      await expect(env.client.workflow.execute("roomAgentActionWorkflow", { taskQueue: queue, workflowId: "space-room-action:action:legacy",
        args: [actionInput()] })).rejects.toThrow();
      expect(attempts).toBe(5);
      expect(failure).toHaveBeenCalledWith({ roomId: turn().roomId, missionId: item().missionId, actionId: "action:legacy", cancelled: false });
    });
  });

  it("records the successful action workflow", async () => {
    const queue = id("action-ok"); const w = await worker(env, bundles.turns, queue);
    await w.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentActionWorkflow", { taskQueue: queue, workflowId: id("action-ok"),
        args: [{ ...actionInput(), actionId: "action:synthetic" }] });
      expect(await handle.result()).toEqual(actionResult());
      await saveHistory("roomAgentActionWorkflow", await handle.fetchHistory());
    });
  });

  for (const legacy of [false, true]) {
    const branch = legacy ? "pre-patch" : "current";
    it(`${branch} supervisor carries queue and resets processed count at 50`, async () => {
      const queue = id("supervisor"); const stubs = activities();
      const w = await worker(env, legacy ? bundles.legacy : bundles.turns, queue, stubs);
      await w.runUntil(async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("supervisor-bound"),
          args: [roomAgentSupervisorInputSchema.parse({ roomId: turn().roomId, pending: [item(0), item(1)], processedCount: 49 })] });
        const result = await continued(handle);
        const carried = roomAgentSupervisorInputSchema.parse(result.carried);
        expect(carried.processedCount).toBe(0);
        expect(carried.pending).toEqual([item(1)]);
        const markers = result.history.events!.filter(e => e.markerRecordedEventAttributes?.markerName === "core_patch");
        expect(markers.length > 0).toBe(!legacy);
        await saveHistory(legacy ? "roomAgentSupervisorWorkflow-pre-patch" : "roomAgentSupervisorWorkflow", result.history);
        await cancel(handle);
      });
    });

    it(`${branch} supervisor records 250 one-second monitoring polls and carries mission state`, async () => {
      const queue = id("polls"); const stubs = activities();
      stubs.prepareRoomAgentBackgroundContinuation = async () => ({ state: "WAITING" });
      stubs.settleRoomAgentBackgroundMission = async () => false;
      const w = await worker(env, legacy ? bundles.legacy : bundles.turns, queue, stubs);
      await w.runUntil(async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("poll-bound"),
          args: [roomAgentSupervisorInputSchema.parse({ roomId: turn().roomId, monitoringMissionIds: [item().missionId], processedCount: 7 })] });
        const result = await continued(handle);
        const carried = roomAgentSupervisorInputSchema.parse(result.carried);
        expect(carried.monitoringMissionIds).toEqual([item().missionId]);
        expect(carried.processedCount).toBe(legacy ? 7 : 0);
        const expected = legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
        expect(result.history.events!.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === expected)).toHaveLength(250);
        expect(result.history.events!.filter(e => e.timerStartedEventAttributes?.startToFireTimeout?.seconds?.toString() === "1")).toHaveLength(250);
        await cancel(handle);
      });
    }, 60_000);

    it(`${branch} supervisor accepts enqueue and cancels active child on stop`, async () => {
      const queue = id("signals"); const stubs = activities(); const finished = vi.fn(async (_input: unknown) => {});
      stubs.finishRoomAgentSupervisorTurn = finished; stubs.markRoomAgentMissionFinished = finished;
      let began!: () => void;
      const begun = new Promise<void>(resolve => { began = resolve; });
      stubs.runCodexAppServerTurn = async () => {
        began();
        const heartbeat = setInterval(() => Context.current().heartbeat(), 50);
        try { await Context.current().cancelled; } finally { clearInterval(heartbeat); }
        return turnResult(turn());
      };
      const w = await worker(env, legacy ? bundles.legacy : bundles.turns, queue, stubs);
      await w.runUntil(async () => {
        const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("signals"),
          args: [roomAgentSupervisorInputSchema.parse({ roomId: turn().roomId })] });
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item());
        await begun;
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: item().missionId, reason: "Synthetic stop" });
        await vi.waitFor(() => expect(finished).toHaveBeenCalledWith(expect.objectContaining({ status: "INTERRUPTED", statusReason: "Synthetic stop" })), { timeout: 10_000 });
        await cancel(handle);
      });
    }, 20_000);
  }

  it("drains an oversized carry queue without dropping turns before continuing", async () => {
    const queue = id("carry"); const stubs = activities(); let handle: WorkflowHandleWithStartDetails; let flooded = false; let checked = 0;
    stubs.checkRoomAgentSupervisorTurn = async () => {
      checked++;
      if (!flooded) { flooded = true; for (let i = 1; i <= 105; i++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(i)); }
      return "SKIP";
    };
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("carry"),
        args: [roomAgentSupervisorInputSchema.parse({ roomId: turn().roomId, pending: [item(0)], processedCount: 49 })] });
      const result = await continued(handle);
      const carried = roomAgentSupervisorInputSchema.parse(result.carried);
      expect(carried.pending).toEqual(Array.from({ length: 100 }, (_, i) => item(i + 6)));
      expect(result.history.events!.filter(e => e.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn")).toHaveLength(6);
      expect(checked).toBeGreaterThanOrEqual(6);
      await cancel(handle);
    });
  }, 30_000);

  it("carries interrupted, pending and monitoring state together into the next run", async () => {
    const queue = id("all-carried-state"); const stubs = activities();
    const input = roomAgentSupervisorInputSchema.parse({ roomId: turn().roomId, pending: [item(2)],
      interrupted: [{ item: item(0), reason: "First stop" }, { item: item(1), reason: "Second stop" }],
      monitoringMissionIds: ["mission:monitoring"], processedCount: 49 });
    const w = await worker(env, bundles.turns, queue, stubs);
    await w.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue,
        workflowId: id("all-carried-state"), args: [input] });
      const result = await continued(handle);
      expect(roomAgentSupervisorInputSchema.parse(result.carried)).toEqual({ ...input,
        interrupted: [input.interrupted[1]], processedCount: 0 });
      await cancel(handle);
    });
  });

  // These activities use only the existing in-memory regression fixture. The real
  // Temporal workflow still owns signal ordering, child execution and continuation.
  function continuationDriver() {
    const c = continuationFixture(); const stubs = activities(); const children: Parameters<typeof turnResult>[0][] = [];
    const prepare = vi.fn(async (raw: unknown) => prepareBackgroundContinuation(raw as Parameters<typeof prepareBackgroundContinuation>[0], c.store));
    const finish = vi.fn(async (raw: unknown) => finishSupervisorTurn(raw as Parameters<typeof finishSupervisorTurn>[0], c.store));
    stubs.prepareRoomAgentBackgroundContinuation = prepare;
    stubs.checkRoomAgentSupervisorTurn = async raw => supervisorTurnState(raw as ReturnType<typeof item>, c.store);
    stubs.discardRoomAgentSupervisorTurn = async raw => {
      const input = raw as { item: ReturnType<typeof item>; reason: string };
      await discardSupervisorTurn(input.item, input.reason, c.store);
    };
    stubs.finishRoomAgentSupervisorTurn = finish;
    stubs.runCodexAppServerTurn = async input => {
      children.push(input);
      c.store.updateSpaceAgentRun(input.agentRunId!, { status: "COMPLETED" });
      return turnResult(input);
    };
    return { ...c, stubs, children, prepare, finish,
      workflowInput: roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }) };
  }

  it("executes allocation, send and verification within the same mission", async () => {
    const c = continuationDriver(); const queue = id("allocation"); let turns = 0;
    c.stubs.runCodexAppServerTurn = async input => {
      c.children.push(input); c.store.updateSpaceAgentRun(input.agentRunId!, { status: "COMPLETED" });
      if (++turns === 1) {
        expect(input.prompt).toContain("Open CLI and Chat, then send a story");
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        return { ...turnResult(input), roomAgentOutcome: { ...turnResult(input).roomAgentOutcome, pendingActionIds: ["action:send"] } };
      }
      return turnResult(input);
    };
    const w = await worker(env, bundles.turns, queue, c.stubs);
    await w.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("allocation"), args: [c.workflowInput] });
      await vi.waitFor(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED"), { timeout: 10_000 });
      expect(c.children).toHaveLength(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
      expect(c.finish).toHaveBeenCalledTimes(1);
      await cancel(handle);
    });
  });

  it.each(["stop", "follow-up"])("retires a prepared run when %s precedes its activity reply", async kind => {
    const c = continuationDriver(); const queue = id("retire"); let handle: WorkflowHandle; let preparedRunId = "";
    c.prepare.mockImplementationOnce(async raw => {
      const result = await prepareBackgroundContinuation(raw as Parameters<typeof prepareBackgroundContinuation>[0], c.store);
      expect(result.state).toBe("READY");
      if (result.state === "READY") preparedRunId = result.item.turn.agentRunId!;
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      return result;
    });
    const w = await worker(env, bundles.turns, queue, c.stubs);
    await w.runUntil(async () => {
      handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("retire"), args: [c.workflowInput] });
      await vi.waitFor(() => {
        expect(preparedRunId).toBeTruthy();
        expect(c.store.getRoomAgentTurn(c.initial.mission.id, preparedRunId)?.run.status).toBe("INTERRUPTED");
      }, { timeout: 10_000 });
      if (kind === "stop") expect(c.children).toHaveLength(0);
      else {
        await vi.waitFor(() => expect(c.children).toHaveLength(1), { timeout: 10_000 });
        expect(c.children[0]!.roomAgentOperatorRequest).toBe("Only inspect the room.");
      }
      await cancel(handle);
    });
  });

  it("carries a prepared continuation into the new run and starts it exactly once", async () => {
    const c = continuationDriver(); const queue = id("prepared-carry");
    const w = await worker(env, bundles.turns, queue, c.stubs);
    await w.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("prepared-carry"),
        args: [{ ...c.workflowInput, processedCount: 50 }] });
      const result = await continued(handle);
      const carried = roomAgentSupervisorInputSchema.parse(result.carried);
      expect(carried.pending).toHaveLength(1);
      expect(result.history.events!.filter(e => e.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(0);
      await vi.waitFor(() => expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED"), { timeout: 10_000 });
      expect(c.children).toHaveLength(1);
      expect(c.children[0]!.agentRunId).toBe(carried.pending[0]!.turn.agentRunId);
      await cancel(handle);
    });
  });

  it("pre-patch history retains the boolean settle contract", async () => {
    const queue = id("legacy-settle"); const stubs = activities();
    const settle = vi.fn(async (_input: unknown) => true); const prepare = vi.fn(stubs.prepareRoomAgentBackgroundContinuation);
    stubs.settleRoomAgentBackgroundMission = settle; stubs.prepareRoomAgentBackgroundContinuation = prepare;
    const w = await worker(env, bundles.legacy, queue, stubs);
    await w.runUntil(async () => {
      const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", { taskQueue: queue, workflowId: id("legacy-settle"),
        args: [roomAgentSupervisorInputSchema.parse({ roomId: turn().roomId, monitoringMissionIds: [item().missionId] })] });
      await env.sleep("2 seconds");
      await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
      expect(prepare).not.toHaveBeenCalled();
      await cancel(handle);
    });
  });

  it("runs maintenance child consolidation and mutations on production task queues, tolerating ancillary failures", async () => {
    const stubs = activities(); let refreshes = 0; let reconciles = 0;
    stubs.refreshAllMonthsMemoryGraphSnapshot = async () => { refreshes++; throw ApplicationFailure.retryable("synthetic refresh failure"); };
    stubs.reconcileStaleSpaceAgentSessions = async () => { reconciles++; throw ApplicationFailure.retryable("synthetic reconcile failure"); };
    const maintenance = await worker(env, bundles.maintenance, MEMORY_CONSOLIDATION_TASK_QUEUE, stubs);
    const mutation = await worker(env, bundles.mutation, MEMORY_MUTATION_TASK_QUEUE, stubs);
    await maintenance.runUntil(() => mutation.runUntil(async () => {
      const handle = await env.client.workflow.start("memoryMaintenanceWorkflow", { taskQueue: MEMORY_CONSOLIDATION_TASK_QUEUE, workflowId: id("maintenance"),
        args: [{ scheduledAt: syntheticTime, traceId: "trace:maintenance" }] });
      expect(await handle.result()).toEqual(maintenanceResult());
      expect(refreshes).toBe(3); expect(reconciles).toBe(3);
      await saveHistory("memoryMaintenanceWorkflow", await handle.fetchHistory());
      const child = env.client.workflow.getHandle("workflow:synthetic-consolidation");
      expect(await child.result()).toMatchObject({ status: "SUCCEEDED", appliedOperationCount: 1 });
      await saveHistory("memoryConsolidationWorkflow", await child.fetchHistory());
      const direct = await env.client.workflow.start("memoryMutationWorkflow", { taskQueue: MEMORY_MUTATION_TASK_QUEUE,
        workflowId: id("mutation"), args: [{ changeSetId: "changeset:synthetic", traceId: "trace:mutation" }] });
      expect(await direct.result()).toMatchObject({ status: "APPLIED" });
      await saveHistory("memoryMutationWorkflow", await direct.fetchHistory());
    }));
  }, 30_000);

  it("propagates memory mutation failure after all three retries", async () => {
    const queue = id("mutation-fail"); const stubs = activities(); let attempts = 0;
    stubs.executePersistedMemoryChangeSet = async () => { attempts++; throw ApplicationFailure.retryable("synthetic mutation failure"); };
    const w = await worker(env, bundles.mutation, queue, stubs);
    await w.runUntil(async () => {
      await expect(env.client.workflow.execute("memoryMutationWorkflow", { taskQueue: queue, workflowId: id("mutation-fail"),
        args: [{ changeSetId: "changeset:synthetic", traceId: "trace:mutation" }] })).rejects.toThrow();
      expect(attempts).toBe(3);
    });
  });

  it("replays every required real synthetic history, including the pre-patch branch", async () => {
    const histories = await Promise.all(names.map(async name => ({ workflowId: name, history: await loadHistory(name) })));
    for (const h of histories) {
      expect(h.history.events!.length, h.workflowId).toBeGreaterThan(1);
      expect(h.history.events![0]!.workflowExecutionStartedEventAttributes?.workflowType?.name, h.workflowId)
        .toBe(h.workflowId.replace("-pre-patch", ""));
    }
    for (const kind of ["turns", "maintenance", "mutation"] as const) {
      const selected = histories.filter(h => kind === "maintenance" ? /memory(Maintenance|Consolidation)/.test(h.workflowId)
        : kind === "mutation" ? h.workflowId === "memoryMutationWorkflow" : !h.workflowId.startsWith("memory"));
      const results = [];
      for await (const result of Worker.runReplayHistories({ workflowBundle: bundles[kind] }, selected)) results.push(result);
      expect(results).toHaveLength(selected.length);
      for (const result of results) {
        if (result.error) throw new Error(`Replay failed for workflow ${result.workflowId.replace("-pre-patch", "")}; history tests/fixtures/workflow-histories/${result.workflowId}.json`, { cause: result.error });
      }
    }
  }, 30_000);

  it("rejects an actual recorded history after an incompatible timer is added", async () => {
    const history = await loadHistory("dotGoalWorkflow");
    await expect(Worker.runReplayHistory({ workflowsPath: path.join(here, "fixtures/incompatible-dot-workflow.ts") }, history)).rejects.toBeInstanceOf(DeterminismViolationError);
  }, 20_000);
});
