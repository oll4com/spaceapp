import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DeterminismViolationError } from "@temporalio/workflow";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import {
  activities, bundle, completed, Context, histories, item,
  saveHistory, supervisor, TestWorkflowEnvironment, withWorkers, Worker,
  type Sandbox
} from "./support/temporal-sandbox.js";

let sandbox: Sandbox;
let legacy: Sandbox;
vi.setConfig({ testTimeout: 45_000 });
beforeAll(async () => {
  sandbox = { env: undefined!, bundle: await bundle() };
  legacy = { env: undefined!, bundle: await bundle("legacy") };
}, 120_000);
beforeEach(async () => { sandbox.env = await TestWorkflowEnvironment.createTimeSkipping(); legacy.env = sandbox.env; }, 30_000);
afterEach(async () => { await sandbox?.env?.teardown(); });

const workflowId = () => `synthetic:${randomUUID()}`;
async function eventually(predicate: () => boolean | Promise<boolean>, message: string) {
  for (let i = 0; i < 1000; i++) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out: ${message}`);
}
async function firstHistory(handle: any) {
  return sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId).fetchHistory();
}
function continuedInput(history: any) {
  const event = history.events.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes);
  if (!event) return undefined;
  return JSON.parse(Buffer.from(event.workflowExecutionContinuedAsNewEventAttributes.input.payloads[0].data).toString());
}
function continuationDriver() {
  const fixture = continuationFixture();
  let children = 0;
  const stubs = activities({
    prepareRoomAgentBackgroundContinuation: input => prepareBackgroundContinuation(input, fixture.store),
    checkRoomAgentSupervisorTurn: turn => supervisorTurnState(turn, fixture.store),
    discardRoomAgentSupervisorTurn: ({ item, reason }) => discardSupervisorTurn(item, reason, fixture.store),
    finishRoomAgentSupervisorTurn: input => finishSupervisorTurn(input, fixture.store),
    runCodexAppServerTurn: async turn => {
      children++;
      fixture.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return completed;
    }
  });
  return { ...fixture, stubs, childCount: () => children,
    input: supervisor({ roomId: fixture.room.id, monitoringMissionIds: [fixture.initial.mission.id] }) };
}
// Each test has a fresh time-skipping server. Bundles are shared, not virtual
// time, queues or workflow state. Activity overrides are independent too.
describe.sequential("real Temporal sandbox and replay compatibility", () => {
  it("retries dummy turn activities and records a completed execution", async () => {
    let attempts = 0;
    await withWorkers(sandbox, activities({ recordDummyTurnStarted: async () => {
      attempts = Context.current().info.attempt;
      if (attempts === 1) throw new Error("Synthetic transient failure");
    } }), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("dummyTurnWorkflow", {
        taskQueue, workflowId: workflowId(), args: [item("dummy").turn]
      });
      expect(await handle.result()).toEqual(completed);
      expect(attempts).toBe(2);
      await saveHistory("dummy-turn-retry", handle);
    });
  });

  it.each(["opencode", "cli:claude", "codex"])("routes a real turn for provider %s", async providerId => {
    const calls: string[] = [];
    await withWorkers(sandbox, activities(Object.fromEntries([
      "runOpenCodeAgentTurn", "runCliAgentTurn", "runCodexAppServerTurn"
    ].map(name => [name, async () => {
      calls.push(name);
      if (name === "runCodexAppServerTurn" && Context.current().info.attempt === 1) throw new Error("Synthetic turn retry");
      return completed;
    }]))), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("codexAppServerTurnWorkflow", {
        taskQueue, workflowId: workflowId(), args: [{ ...item("turn").turn, providerId }]
      });
      expect(await handle.result()).toEqual(completed);
      expect(calls).toEqual(providerId === "opencode" ? ["runOpenCodeAgentTurn"] : providerId === "cli:claude" ? ["runCliAgentTurn"]
        : ["runCodexAppServerTurn", "runCodexAppServerTurn"]);
      await saveHistory(`codex-turn-${providerId.replace(":", "-")}`, handle);
    });
  });

  it.each(["timeout", "wake"])("dot goal waits for %s before observing its turn", async mode => {
    let steps = 0;
    let observes = 0;
    let handle: any;
    let ready!: () => void;
    const firstStep = new Promise<void>(resolve => { ready = resolve; });
    await withWorkers(sandbox, activities({
      dotGoalStep: async () => {
        if (++steps === 1) { ready(); return { state: "RUNNING", runId: "run:synthetic", goalStatus: "ACTIVE" }; }
        return { state: "DONE", runId: null, goalStatus: "COMPLETED" };
      },
      dotGoalObserve: async () => { observes++; return { run: "COMPLETED", goalStatus: "ACTIVE" }; }
    }), async taskQueue => {
      handle = await sandbox.env.client.workflow.start("dotGoalWorkflow", {
        taskQueue, workflowId: workflowId(), args: [{ goalId: "goal:synthetic" }]
      });
      await firstStep;
      if (mode === "wake") await handle.signal("dotGoalWake");
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(observes).toBe(1);
      const history = await saveHistory(`dot-goal-${mode}`, handle);
      const cancelledTimers = history.events.filter((e: any) => e.timerCanceledEventAttributes);
      if (mode === "timeout") expect(cancelledTimers).toHaveLength(0);
      // A wake during the activity can avoid scheduling a timer entirely.
      else expect(history.events.some((e: any) => e.workflowExecutionSignaledEventAttributes)).toBe(true);
    });
  });

  it("continues an unfinished goal after 300 steps and carries the same goal id", async () => {
    let steps = 0;
    const goalIds: string[] = [];
    await withWorkers(sandbox, activities({ dotGoalStep: async (goalId: string) => {
      goalIds.push(goalId);
      return ++steps > 300 ? { state: "DONE", runId: null, goalStatus: "COMPLETED" }
        : { state: "WAITING", runId: null, goalStatus: "ACTIVE" };
    } }), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("dotGoalWorkflow", {
        taskQueue, workflowId: workflowId(), args: [{ goalId: "goal:continue" }]
      });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(steps).toBe(301);
      expect(new Set(goalIds)).toEqual(new Set(["goal:continue"]));
      // fetchHistory on the original run, not only its successful successor.
      const history = await saveHistory("dot-goal-continue", sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId));
      expect(history.events.some((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)).toBe(true);
    });
  }, 45_000);

  it("persists background action failure after activity retries are exhausted", async () => {
    const failures: any[] = [];
    let attempts = 0;
    await withWorkers(sandbox, activities({
      runRoomAgentBackgroundAction: async () => { attempts = Context.current().info.attempt; throw new Error("Synthetic action failure"); },
      failRoomAgentBackgroundAction: async input => { failures.push(input); }
    }), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("roomAgentActionWorkflow", {
        taskQueue, workflowId: "space-room-action:synthetic-failure", args: [{ bridge: {
          roomId: "room:synthetic", missionId: "mission:synthetic" }, traceId: "trace:synthetic" }]
      });
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toBe(5);
      expect(failures).toEqual([{ roomId: "room:synthetic", missionId: "mission:synthetic", actionId: "synthetic-failure", cancelled: false }]);
      await saveHistory("background-action-failure", handle);
    });
  });

  it("continues maintenance after refresh and reconciliation failures, running the real child workflow", async () => {
    let refreshAttempts = 0;
    let reconcileAttempts = 0;
    let mutationAttempts = 0;
    const mutations: any[] = [];
    await withWorkers(sandbox, activities({
      refreshAllMonthsMemoryGraphSnapshot: async () => { refreshAttempts = Context.current().info.attempt; throw new Error("Synthetic refresh failure"); },
      reconcileStaleSpaceAgentSessions: async () => { reconcileAttempts = Context.current().info.attempt; throw new Error("Synthetic reconcile failure"); },
      executePersistedMemoryChangeSet: async input => {
        mutationAttempts = Context.current().info.attempt;
        if (mutationAttempts === 1) throw new Error("Synthetic mutation retry");
        mutations.push(input); return { status: "APPLIED" };
      }
    }), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("memoryMaintenanceWorkflow", {
        taskQueue, workflowId: workflowId(), args: [{ traceId: "trace:memory" }]
      });
      expect(await handle.result()).toEqual({ sourceHash: "synthetic-source" });
      expect([refreshAttempts, reconcileAttempts, mutationAttempts]).toEqual([3, 3, 2]);
      expect(mutations).toEqual([{ changeSetId: "change:synthetic", traceId: "trace:memory" }]);
      const history = await saveHistory("memory-maintenance-failures", handle);
      const child = history.events.find((e: any) => e.childWorkflowExecutionStartedEventAttributes)?.childWorkflowExecutionStartedEventAttributes;
      expect(child?.workflowType?.name).toBe("memoryConsolidationWorkflow");
      const childHandle = sandbox.env.client.workflow.getHandle(child!.workflowExecution!.workflowId!, child!.workflowExecution!.runId!);
      await saveHistory("memory-consolidation-child", childHandle);
    }, true);
  });

  it("returns a consolidation with no changes without scheduling a mutation", async () => {
    let mutated = false;
    await withWorkers(sandbox, activities({
      prepareMemoryConsolidation: async () => ({ changeSetId: null, run: { id: "run:empty" } }),
      executePersistedMemoryChangeSet: async () => { mutated = true; }
    }), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("memoryConsolidationWorkflow", {
        taskQueue, workflowId: workflowId(), args: [{ runId: "run:empty" }]
      });
      expect(await handle.result()).toEqual({ id: "run:empty" });
      expect(mutated).toBe(false);
      await saveHistory("memory-consolidation-empty", handle);
    });
  });

  it("retries a memory mutation in the real workflow sandbox", async () => {
    let attempts = 0;
    await withWorkers(sandbox, activities({ executePersistedMemoryChangeSet: async input => {
      attempts = Context.current().info.attempt;
      if (attempts < 3) throw new Error("Synthetic transient mutation");
      return { ...input, status: "APPLIED" };
    } }), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("memoryMutationWorkflow", {
        taskQueue, workflowId: workflowId(), args: [{ changeSetId: "change:mutation", traceId: "trace:mutation" }]
      });
      expect(await handle.result()).toEqual({ changeSetId: "change:mutation", traceId: "trace:mutation", status: "APPLIED" });
      expect(attempts).toBe(3);
      await saveHistory("memory-mutation-retry", handle);
    });
  });

  it.each(["current", "legacy"])("%s supervisor enqueues work, cancels its active child and retires queued work", async branch => {
    const selected = branch === "legacy" ? legacy : sandbox;
    const finished: any[] = [];
    let childStarted = false;
    await withWorkers(selected, activities({
      runCodexAppServerTurn: async () => {
        childStarted = true;
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat(), 20);
        try { await context.cancelled; } finally { clearInterval(heartbeat); }
      },
      finishRoomAgentSupervisorTurn: async input => { finished.push({ missionId: input.item.missionId, ...input }); },
      markRoomAgentMissionFinished: async input => { finished.push(input); }
    }), async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: workflowId(), args: [supervisor()]
      });
      try {
        const active = item("cancel-active");
        await handle.signal("enqueueRoomAgentMission", active);
        await eventually(() => childStarted, "child activity started");
        const queued = { ...item("cancel-queued"), missionId: "mission:queued" };
        await handle.signal("enqueueRoomAgentMission", queued);
        await handle.signal("stopRoomAgentMission", { missionId: null, reason: "Synthetic operator stop" });
        await eventually(() => finished.length === 2, "both active and pending missions retired");
        expect(finished.map(f => f.missionId).sort()).toEqual([active.missionId, queued.missionId].sort());
        expect(finished.every(f => f.status === "INTERRUPTED" && f.statusReason === "Synthetic operator stop")).toBe(true);
      } finally { await handle.terminate("Synthetic test cleanup"); }
      await saveHistory(`supervisor-${branch}-stop`, handle);
    });
  });

  it.each(["current", "legacy"])("%s supervisor carries pending/monitoring state at the 50 item boundary", async branch => {
    const selected = branch === "legacy" ? legacy : sandbox;
    await withWorkers(selected, activities({ checkRoomAgentSupervisorTurn: async () => "SKIP",
      prepareRoomAgentBackgroundContinuation: async () => ({ state: "WAITING" }), settleRoomAgentBackgroundMission: async () => false
    }), async taskQueue => {
      const pending = [item("boundary-first"), item("boundary-second")];
      const handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: workflowId(), args: [supervisor({ pending, processedCount: 49, monitoringMissionIds: ["mission:monitor"] })]
      });
      try {
        await eventually(async () => Boolean(continuedInput(await firstHistory(handle))), "50 item continue-as-new");
        const carry = continuedInput(await firstHistory(handle));
        expect(carry.pending).toEqual([pending[1]]);
        expect(carry.monitoringMissionIds).toEqual(["mission:monitor"]);
        expect(carry.processedCount).toBe(0);
        expect(carry.interrupted).toEqual([]);
        expect(() => supervisor(carry)).not.toThrow();
        await saveHistory(`supervisor-${branch}-50-items`, sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId));
      } finally { await handle.terminate("Synthetic test cleanup"); }
    });
  });

  it.each(["current", "legacy"])("%s supervisor uses 1s polling and carries monitoring after 250 polls", async branch => {
    const selected = branch === "legacy" ? legacy : sandbox;
    let polls = 0;
    let handle: any;
    async function polled() {
      if (++polls === 251) await handle.terminate("Synthetic successor observed after 250 polls");
    }
    await withWorkers(selected, activities({
      prepareRoomAgentBackgroundContinuation: async () => { await polled(); return { state: "WAITING" }; },
      settleRoomAgentBackgroundMission: async () => { await polled(); return false; }
    }), async taskQueue => {
      handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: workflowId(), workflowExecutionTimeout: "260 seconds",
        args: [supervisor({ monitoringMissionIds: ["mission:monitor"], processedCount: 7 })]
      });
      try {
        // Awaiting result enables global time skipping. The 251st activity
        // is in the successor run and terminates this intentionally infinite
        // supervisor. Do not rely on execution timeout semantics in the Java
        // test server across continue-as-new.
        await expect(handle.result()).rejects.toThrow();
        const history = await firstHistory(handle);
        const carry = continuedInput(history);
        expect(carry).toBeDefined();
        expect(carry.monitoringMissionIds).toEqual(["mission:monitor"]);
        expect(carry.pending).toEqual([]);
        expect(carry.processedCount).toBe(branch === "legacy" ? 7 : 0);
        expect(polls).toBeGreaterThanOrEqual(250);
        const timers = history.events!.filter(e => e.timerStartedEventAttributes);
        expect(timers).toHaveLength(250);
        expect(timers.every(e => Number(e.timerStartedEventAttributes?.startToFireTimeout?.seconds) === 1)).toBe(true);
        await saveHistory(`supervisor-${branch}-250-polls`, sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId));
      } finally { await handle.terminate("Synthetic test cleanup").catch(() => undefined); }
    });
  });

  it("drains excess queued work before continuing so carried input remains valid", async () => {
    let handle: any;
    let checks = 0;
    await withWorkers(sandbox, activities({ checkRoomAgentSupervisorTurn: async () => {
      if (++checks === 1) {
        // Signals are sent through the actual client while an activity is in flight.
        for (let i = 1; i <= 105; i++) await handle.signal("enqueueRoomAgentMission", item(`flood-${i}`));
      }
      return "SKIP";
    } }), async taskQueue => {
      handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: workflowId(), args: [supervisor({ pending: [item("flood-0")], processedCount: 49 })]
      });
      try {
        await eventually(async () => Boolean(continuedInput(await firstHistory(handle))), "bounded state continue-as-new");
        const carry = continuedInput(await firstHistory(handle));
        expect(carry.pending).toHaveLength(100);
        expect(carry.pending[0].turn.agentRunId).toBe("agent_run:flood-6");
        expect(() => supervisor(carry)).not.toThrow();
        await saveHistory("supervisor-bounded-carry", sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId));
      } finally { await handle.terminate("Synthetic test cleanup"); }
    });
  });

  it("runs allocation -> send -> verification in one mission with the real continuation store", async () => {
    const c = continuationDriver();
    let turns = 0;
    c.stubs.runCodexAppServerTurn = async turn => {
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      if (++turns === 1) {
        expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both synthetic tasks completed." });
        return { ...completed, roomAgentOutcome: { ...completed.roomAgentOutcome, pendingActionIds: ["action:send"] } };
      }
      return completed;
    };
    await withWorkers(sandbox, c.stubs, async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: workflowId(), args: [c.input]
      });
      try {
        await sandbox.env.sleep("5 seconds");
        await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED", "allocation/send/verification completion");
        expect(turns).toBe(2);
        expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
      } finally { await handle.terminate("Synthetic test cleanup"); }
      await saveHistory("supervisor-allocation-send-verify", handle);
    });
  });

  it.each(["stop", "follow-up"])("retires a prepared automatic run when %s arrives before its activity reply", async kind => {
    const c = continuationDriver();
    let handle: any;
    let preparedRun: string | undefined;
    let operatorRequest: string | undefined;
    let prepared = false;
    c.stubs.prepareRoomAgentBackgroundContinuation = async input => {
      const result = await prepareBackgroundContinuation(input, c.store);
      if (!prepared && result.state === "READY") {
        prepared = true;
        preparedRun = result.item.turn.agentRunId;
        if (kind === "stop") {
          c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
          await handle.signal("stopRoomAgentMission", { missionId: null, reason: "Synthetic stop during preparation" });
        } else {
          const follow = c.enqueue("follow-up", "Only inspect the room.");
          await handle.signal("enqueueRoomAgentMission", follow.queueItem);
        }
      }
      return result;
    };
    const child = c.stubs.runCodexAppServerTurn;
    c.stubs.runCodexAppServerTurn = async turn => { operatorRequest = turn.roomAgentOperatorRequest; return child(turn); };
    await withWorkers(sandbox, c.stubs, async taskQueue => {
      handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: workflowId(), args: [c.input]
      });
      try {
        await sandbox.env.sleep("3 seconds");
        await eventually(() => Boolean(preparedRun) && c.store.getRoomAgentTurn(c.initial.mission.id, preparedRun!)?.run.status === "INTERRUPTED", "prepared run discarded after signal");
        if (kind === "stop") expect(c.childCount()).toBe(0);
        else {
          await eventually(() => c.childCount() === 1, "operator follow-up child");
          expect(operatorRequest).toBe("Only inspect the room.");
        }
      } finally { await handle.terminate("Synthetic test cleanup"); }
      await saveHistory(`supervisor-preparation-${kind}`, handle);
    });
  });

  it("carries a prepared continuation through continue-as-new and starts it exactly once", async () => {
    const c = continuationDriver();
    await withWorkers(sandbox, c.stubs, async taskQueue => {
      const handle = await sandbox.env.client.workflow.start("roomAgentSupervisorWorkflow", {
        taskQueue, workflowId: workflowId(), args: [{ ...c.input, processedCount: 50 }]
      });
      try {
        await sandbox.env.sleep("3 seconds");
        await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED", "continued mission completion");
        const history = await firstHistory(handle);
        expect(continuedInput(history).pending).toHaveLength(1);
        expect(history.events!.some(e => e.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
        expect(c.childCount()).toBe(1);
        await saveHistory("supervisor-prepared-carry", sandbox.env.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId));
      } finally { await handle.terminate("Synthetic test cleanup"); }
    });
  });

  it("replays every committed history against production workflows", async () => {
    const fixtures = await histories();
    const types = new Set(fixtures.map(({ history }) => history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name));
    expect(types).toEqual(new Set(["dotGoalWorkflow", "dummyTurnWorkflow", "codexAppServerTurnWorkflow", "roomAgentSupervisorWorkflow",
      "roomAgentActionWorkflow", "memoryMaintenanceWorkflow", "memoryConsolidationWorkflow", "memoryMutationWorkflow"]));
    expect(fixtures.some(f => f.workflowId.includes("legacy"))).toBe(true);
    let replayed = 0;
    for await (const result of Worker.runReplayHistories({ workflowBundle: sandbox.bundle }, fixtures)) {
      const fixture = fixtures.find(f => f.workflowId === result.workflowId)!;
      const type = fixture.history.events?.[0]?.workflowExecutionStartedEventAttributes?.workflowType?.name;
      expect(result.error, `Replay failed: ${type}, history ${result.workflowId}: ${result.error}`).toBeUndefined();
      replayed++;
    }
    expect(replayed).toBe(fixtures.length);
  }, 45_000);

  it("rejects a test-only extra activity with DeterminismViolationError", async () => {
    const fixture = (await histories()).find(f => f.workflowId === "dummy-turn-retry.json")!;
    const invalid = await bundle("invalid");
    const results = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle: invalid }, [fixture])) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]!.workflowId).toBe(fixture.workflowId);
    expect(results[0]!.error).toBeInstanceOf(DeterminismViolationError);
  }, 30_000);
});
