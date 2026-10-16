import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Context } from "@temporalio/activity";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Runtime, DefaultLogger, Worker, bundleWorkflowCode } from "@temporalio/worker";
import { DeterminismViolationError } from "@temporalio/workflow";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { temporal } from "@temporalio/proto";
import {
  DOT_GOAL_SIGNAL, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema
} from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import { Harness, bundle, continuedInput, deferred, fixtures, here, recording, signalProcessed, until } from "./temporal/harness.js";

const turn = (id = "one") => ({
  roomId: "room:temporal-proof", paneId: "pane:temporal-proof", prompt: "Synthetic test request",
  artifactIds: [], agentRunId: `agent_run:${id}`, traceId: `trace:test-${id}`,
  permissionMode: null, collaborationMode: "default" as const
});
const item = (id = "one") => roomAgentSupervisorQueueItemSchema.parse({ missionId: `mission:${id}`, turn: turn(id) });
const verified = { status: "COMPLETED", message: "Synthetic verification", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Synthetic evidence verified"
} };
const supervisorInput = (extra = {}) => roomAgentSupervisorInputSchema.parse({ roomId: turn().roomId, ...extra });
let h: Harness;
let current: Awaited<ReturnType<typeof bundle>>;
let legacyBundle: Awaited<ReturnType<typeof bundle>>;
let environment: TestWorkflowEnvironment | undefined;
vi.setConfig({ testTimeout: 20_000 });

// Time skipping is global to a server. Each scenario gets a fresh server so
// cancellation and continued runs cannot leave time locks affecting later tests.
// Bundles are expensive and immutable, so compile those only once.
describe.sequential("production workflows on the Temporal time-skipping server", () => {
  beforeAll(async () => {
    Runtime.install({ logger: new DefaultLogger("ERROR") });
    current = await bundle();
    legacyBundle = await bundle(true);
  }, 60_000);
  beforeEach(async () => {
    environment = undefined;
    environment = await TestWorkflowEnvironment.createTimeSkipping();
    h = new Harness(environment, current, legacyBundle);
  }, 20_000);
  afterEach(async () => { await environment?.teardown(); }, 20_000);

  it("runs dummy activities in order, retrying a transient failure", async () => {
    const calls: string[] = [];
    await h.run({
      recordDummyTurnStarted: async () => {
        calls.push(`start:${Context.current().info.attempt}`);
        if (Context.current().info.attempt === 1) throw new Error("Synthetic transient error");
      },
      recordDummyTurnCompleted: async () => { calls.push("complete"); return { ...turn(), workflowId: "dummy", status: "COMPLETED", message: "done" }; }
    }, async s => {
      const handle = await s.start("dummyTurnWorkflow", turn());
      expect(await handle.result()).toMatchObject({ status: "COMPLETED" });
      expect(calls).toEqual(["start:1", "start:2", "complete"]);
      await s.finish(handle, "dummy-turn-retry");
    });
  });

  it.each(["codex", "opencode", "cli:claude"])("dispatches %s turns and preserves retry policy", async providerId => {
    const attempts: number[] = [];
    const activity = async () => {
      attempts.push(Context.current().info.attempt);
      if (attempts.length === 1) throw new Error("Synthetic turn failure");
      return verified;
    };
    const activityName = providerId === "opencode" ? "runOpenCodeAgentTurn" : providerId === "cli:claude" ? "runCliAgentTurn" : "runCodexAppServerTurn";
    await h.run({ [activityName]: activity }, async s => {
      const handle = await s.start("codexAppServerTurnWorkflow", { ...turn(), providerId });
      if (providerId === "codex") {
        expect(await handle.result()).toEqual(verified);
        expect(attempts).toEqual([1, 2]);
      } else {
        await expect(handle.result()).rejects.toThrow();
        expect(attempts).toEqual([1]);
      }
      await s.finish(handle, `turn-${providerId.replace(":", "-")}`);
    });
  });

  it("exhausts the five room-turn attempts", async () => {
    const attempts: number[] = [];
    await h.run({ runCodexAppServerTurn: async () => {
      attempts.push(Context.current().info.attempt); throw new Error("Synthetic permanent transport failure");
    } }, async s => {
      const handle = await s.start("codexAppServerTurnWorkflow", { ...turn(), roomAgentMissionId: "mission:one" });
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      await s.finish(handle, "turn-exhausted");
    });
  });

  it("wakes a paused dot before its one-hour timeout", async () => {
    let steps = 0;
    await h.run({ dotGoalStep: async () => ++steps === 1
      ? { state: "PAUSED", runId: null, goalStatus: "PAUSED" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    }, async s => {
      const handle = await s.start("dotGoalWorkflow", { goalId: "goal:signal" });
      await until(async () => (await handle.fetchHistory()).events!.some(e => e.timerStartedEventAttributes), "dot wait timer");
      await handle.signal(DOT_GOAL_SIGNAL);
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const history = await s.finish(handle, "dot-signal");
      expect(history.events!.some(e => e.timerCanceledEventAttributes)).toBe(true);
      expect(history.events!.some(e => e.timerFiredEventAttributes)).toBe(false);
    });
  });

  it("times out dot polling and observes a running step", async () => {
    let steps = 0;
    const observe = vi.fn(async () => ({ run: "COMPLETED", goalStatus: "RUNNING" }));
    await h.run({ dotGoalStep: async () => ++steps === 1
      ? { state: "RUNNING", runId: "run:dot", goalStatus: "RUNNING" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" }, dotGoalObserve: observe
    }, async s => {
      const handle = await s.start("dotGoalWorkflow", { goalId: "goal:timeout" });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      expect(observe).toHaveBeenCalledWith("goal:timeout", "run:dot");
      const history = await s.finish(handle, "dot-timeout");
      expect(history.events!.some(e => e.timerFiredEventAttributes)).toBe(true);
    });
  });

  it("continues an unfinished dot after 300 iterations and preserves its goal", async () => {
    let steps = 0;
    await h.run({ dotGoalStep: async () => ++steps <= 300
      ? { state: "WAITING", runId: null, goalStatus: "RUNNING" }
      : { state: "DONE", runId: null, goalStatus: "COMPLETED" }
    }, async s => {
      const handle = await s.start("dotGoalWorkflow", { goalId: "goal:continued" });
      expect(await handle.result()).toEqual({ goalStatus: "COMPLETED" });
      const history = await s.originalHistory(handle);
      expect(continuedInput(history)).toEqual({ goalId: "goal:continued" });
      expect(steps).toBe(301);
      await s.save("dot-continued", history);
    });
  }, 30_000);

  it("persists action failure with the legacy action-id fallback after five attempts", async () => {
    const attempts: number[] = [];
    const failed = vi.fn(async () => undefined);
    await h.run({ runRoomAgentBackgroundAction: async () => {
      attempts.push(Context.current().info.attempt); throw new Error("Synthetic transport failed");
    }, failRoomAgentBackgroundAction: failed }, async s => {
      const handle = await s.start("roomAgentActionWorkflow", {
        bridge: { roomId: "room:proof", missionId: "mission:proof" }, traceId: "trace:proof"
      }, "space-room-action:action:legacy");
      await expect(handle.result()).rejects.toThrow();
      expect(attempts).toEqual([1, 2, 3, 4, 5]);
      expect(failed).toHaveBeenCalledExactlyOnceWith({
        roomId: "room:proof", missionId: "mission:proof", actionId: "action:legacy", cancelled: false
      });
      await s.finish(handle, "action-failure-patch");
    });
  });

  it("continues memory maintenance after optional refresh/reconciliation failures and executes its child", async () => {
    const snapshot = { sourceHash: "synthetic-source", status: "COMPLETED" };
    const attempts: Record<string, number[]> = { allMonths: [], reconcile: [] };
    const prepare = vi.fn(async () => ({ changeSetId: null, run: { id: "audit:one", status: "COMPLETED" } }));
    const fail = (key: string) => async () => { attempts[key]!.push(Context.current().info.attempt); throw new Error(`Synthetic ${key} failure`); };
    const audit = vi.fn(async () => ({ id: "audit:one", workflowId: "audit:synthetic-child" }));
    await h.run({ refreshMemoryGraphSnapshot: async () => snapshot,
      refreshAllMonthsMemoryGraphSnapshot: fail("allMonths"), reconcileStaleSpaceAgentSessions: fail("reconcile"),
      createScheduledMemoryAudit: audit, prepareMemoryConsolidation: prepare
    }, async s => {
      const input = { traceId: "trace:memory" };
      const handle = await s.start("memoryMaintenanceWorkflow", input);
      expect(await handle.result()).toEqual(snapshot);
      expect(attempts).toEqual({ allMonths: [1, 2, 3], reconcile: [1, 2, 3] });
      expect(audit).toHaveBeenCalledWith({ ...input, sourceHash: snapshot.sourceHash });
      expect(prepare).toHaveBeenCalledExactlyOnceWith({ runId: "audit:one", traceId: input.traceId });
      await s.finish(handle, "memory-maintenance");
      await s.save("memory-consolidation-no-change", await h.env.client.workflow.getHandle("audit:synthetic-child").fetchHistory());
    });
  });

  it("retries a memory mutation on its dedicated queue before finalizing consolidation", async () => {
    const calls: string[] = [];
    const mutation = { changeSetId: "change:one", status: "APPLIED" };
    const result = { id: "audit:repair", status: "COMPLETED" };
    const finalize = vi.fn(async () => { calls.push("finalize"); return result; });
    await h.run({ prepareMemoryConsolidation: async () => ({ changeSetId: "change:one", run: result }),
      executePersistedMemoryChangeSet: async () => {
        expect(Context.current().info.taskQueue).toBe("space-memory-mutations");
        const attempt = Context.current().info.attempt; calls.push(`mutation:${attempt}`);
        if (attempt < 3) throw new Error("Synthetic mutation conflict");
        return mutation;
      }, finalizeMemoryRepair: finalize
    }, async s => {
      const handle = await s.start("memoryConsolidationWorkflow", { runId: "audit:repair", traceId: "trace:repair" });
      expect(await handle.result()).toEqual(result);
      expect(calls).toEqual(["mutation:1", "mutation:2", "mutation:3", "finalize"]);
      expect(finalize).toHaveBeenCalledWith({ runId: "audit:repair", changeSetId: "change:one", mutationResult: mutation });
      await s.finish(handle, "memory-consolidation-mutation");
    });
  });

  it.each([false, true])("standalone memory mutation fails=%s with at most three attempts", async fails => {
    const attempts: number[] = [];
    await h.run({ executePersistedMemoryChangeSet: async () => {
      const attempt = Context.current().info.attempt; attempts.push(attempt);
      if (fails || attempt === 1) throw new Error("Synthetic mutation failure");
      return { changeSetId: "change:standalone", status: "APPLIED" };
    } }, async s => {
      const handle = await s.start("memoryMutationWorkflow", { changeSetId: "change:standalone", traceId: "trace:mutation" });
      if (fails) await expect(handle.result()).rejects.toThrow();
      else expect(await handle.result()).toMatchObject({ status: "APPLIED" });
      expect(attempts).toEqual(fails ? [1, 2, 3] : [1, 2]);
      await s.finish(handle, `memory-mutation-${fails ? "failure" : "retry"}`);
    });
  });

  it.each([false, true])("supervisor legacy=%s enqueues, ignores duplicates and stops an active child plus queued work", async legacy => {
    const running = deferred();
    const finishes: any[] = [];
    const executions: string[] = [];
    await h.run({
      checkRoomAgentSupervisorTurn: async () => "RUN",
      markRoomAgentMissionStarted: async () => undefined,
      discardRoomAgentSupervisorTurn: async () => undefined,
      finishRoomAgentSupervisorTurn: async (value: any) => { finishes.push(value); },
      markRoomAgentMissionFinished: async (value: any) => { finishes.push(value); },
      runCodexAppServerTurn: async (input: any) => {
        executions.push(input.agentRunId); running.resolve();
        const context = Context.current();
        // Heartbeats deliver real server cancellation to the activity.
        const timer = setInterval(() => context.heartbeat(), 10);
        try { await context.cancelled; } finally { clearInterval(timer); }
      }
    }, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", supervisorInput());
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("active"));
      await running.promise;
      await signalProcessed(handle, ROOM_AGENT_ENQUEUE_SIGNAL, item("queued"));
      await signalProcessed(handle, ROOM_AGENT_ENQUEUE_SIGNAL, item("queued"));
      await signalProcessed(handle, ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Synthetic operator stop" });
      await until(() => finishes.length === 2, "active cancellation and queued interruption");
      expect(executions).toEqual(["agent_run:active"]);
      expect(finishes.map(f => f.status)).toEqual(["INTERRUPTED", "INTERRUPTED"]);
      expect(finishes.map(f => f.item?.missionId ?? f.missionId).sort()).toEqual(["mission:active", "mission:queued"]);
      const history = await s.finish(handle, `supervisor-${legacy ? "legacy" : "current"}-stop`);
      expect(history.events!.some(e => e.requestCancelExternalWorkflowExecutionInitiatedEventAttributes)).toBe(true);
    }, legacy);
  }, 20_000);

  it.each([false, true])("supervisor legacy=%s continues after 50 processed turns with pending work intact", async legacy => {
    const seen: string[] = [];
    const finish = vi.fn(async () => undefined);
    await h.run({ checkRoomAgentSupervisorTurn: async () => "RUN", markRoomAgentMissionStarted: async () => undefined,
      finishRoomAgentSupervisorTurn: finish, markRoomAgentMissionFinished: finish,
      runCodexAppServerTurn: async (input: any) => { seen.push(input.agentRunId); return verified; }
    }, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", supervisorInput({ pending: [item("49"), item("50")], processedCount: 49 }));
      const history = await s.waitForContinue(handle);
      const carried = roomAgentSupervisorInputSchema.parse(continuedInput(history));
      expect(carried.pending).toEqual([item("50")]);
      expect(carried.processedCount).toBe(0);
      await until(() => finish.mock.calls.length === 2, "resumed pending turn");
      expect(seen).toEqual(["agent_run:49", "agent_run:50"]);
      await s.save(`supervisor-${legacy ? "legacy" : "current"}-50-turns`, history);
    }, legacy);
  });

  it.each([false, true])("supervisor legacy=%s polls every second and carries monitoring after 250 polls", async legacy => {
    let polls = 0;
    const runIds: string[] = [];
    const poll = async () => { polls++; runIds.push(Context.current().info.workflowExecution!.runId); return legacy ? false : { state: "WAITING" }; };
    await h.run({ settleRoomAgentBackgroundMission: poll, prepareRoomAgentBackgroundContinuation: poll }, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", supervisorInput({ monitoringMissionIds: ["mission:monitor"], processedCount: 7 }));
      try {
        await until(async () => {
          await h.env.sleep("1 second");
          return polls >= 250;
        }, "250 monitoring polls");
        const history = await s.waitForContinue(handle);
        const carried = continuedInput(history);
        expect(carried.monitoringMissionIds).toEqual(["mission:monitor"]);
        expect(carried.pending).toEqual([]);
        expect(carried.processedCount).toBe(legacy ? 7 : 0);
        expect(runIds.filter(id => id === handle.firstExecutionRunId)).toHaveLength(250);
        const timers = history.events!.filter(e => e.timerStartedEventAttributes);
        expect(timers).toHaveLength(250);
        expect(timers.every(e => Number(e.timerStartedEventAttributes!.startToFireTimeout!.seconds) === 1)).toBe(true);
        expect(polls).toBeGreaterThanOrEqual(250);
        await s.save(`supervisor-${legacy ? "legacy" : "current"}-250-polls`, history);
      } finally { await s.finish(handle); }
    }, legacy);
  }, 30_000);

  function driver() {
    const c = continuationFixture();
    const activities = {
      prepareRoomAgentBackgroundContinuation: vi.fn(input => prepareBackgroundContinuation(input, c.store)),
      checkRoomAgentSupervisorTurn: vi.fn(input => supervisorTurnState(input, c.store)),
      discardRoomAgentSupervisorTurn: vi.fn(({ item, reason }) => discardSupervisorTurn(item, reason, c.store)),
      finishRoomAgentSupervisorTurn: vi.fn(input => finishSupervisorTurn(input, c.store)),
      runCodexAppServerTurn: vi.fn(async (input: any) => {
        c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" }); return verified;
      })
    };
    return { ...c, activities, workflowInput: roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }) };
  }

  it("executes allocation -> send -> verification in one mission through real child workflows", async () => {
    const c = driver();
    c.activities.runCodexAppServerTurn.mockImplementationOnce(async (input: any) => {
      expect(input.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
        evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
      c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" });
      return { ...verified, roomAgentOutcome: { ...verified.roomAgentOutcome, pendingActionIds: ["action:send"] } };
    });
    await h.run(c.activities, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", c.workflowInput);
      try {
        await h.advanceUntil(() => c.activities.finishRoomAgentSupervisorTurn.mock.calls.length === 1, "mission verification");
        expect(c.activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2);
        expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
        expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
        await s.finish(handle, "supervisor-allocation-send-verification");
      } finally { await s.finish(handle); }
    });
  });

  it.each(["stop", "follow-up"])("retires a prepared run when %s arrives before the activity reply", async kind => {
    const c = driver();
    const prepared = deferred<any>();
    let hasPrepared = false;
    const release = deferred();
    c.activities.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async input => {
      const result = await prepareBackgroundContinuation(input, c.store);
      prepared.resolve(result); hasPrepared = true; await release.promise; return result;
    });
    await h.run(c.activities, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", c.workflowInput);
      try {
        await h.advanceUntil(() => hasPrepared, "prepared continuation activity");
        const result = await prepared.promise;
        expect(result.state).toBe("READY");
        if (kind === "stop") {
          c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
          await signalProcessed(handle, ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
        } else {
          await signalProcessed(handle, ROOM_AGENT_ENQUEUE_SIGNAL, c.enqueue("follow-up", "Only inspect the room.").queueItem);
        }
        release.resolve();
        await until(() => c.activities.discardRoomAgentSupervisorTurn.mock.calls.length === 1, "prepared turn discarded");
        expect(c.store.getRoomAgentTurn(c.initial.mission.id, result.item.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
        if (kind === "stop") expect(c.activities.runCodexAppServerTurn).not.toHaveBeenCalled();
        else {
          await until(() => c.activities.runCodexAppServerTurn.mock.calls.length > 0, "operator follow-up child");
          expect(c.activities.runCodexAppServerTurn.mock.calls[0]![0].roomAgentOperatorRequest).toBe("Only inspect the room.");
        }
        await s.finish(handle, `supervisor-prepared-${kind}`);
      } finally { release.resolve(); await s.finish(handle); }
    });
  });

  it("carries a prepared continuation through continue-as-new and starts it exactly once", async () => {
    const c = driver();
    const children: string[] = [];
    c.activities.runCodexAppServerTurn.mockImplementation(async (input: any) => {
      children.push(Context.current().info.workflowExecution!.workflowId);
      c.store.updateSpaceAgentRun(input.agentRunId, { status: "COMPLETED" }); return verified;
    });
    await h.run(c.activities, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", { ...c.workflowInput, processedCount: 50 });
      try {
        await h.advanceUntil(() => c.activities.prepareRoomAgentBackgroundContinuation.mock.calls.length > 0, "continuation preparation");
        const history = await s.waitForContinue(handle);
        const carried = roomAgentSupervisorInputSchema.parse(continuedInput(history));
        expect(carried.pending).toHaveLength(1);
        expect(history.events!.filter(e => e.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(0);
        await until(() => c.activities.finishRoomAgentSupervisorTurn.mock.calls.length === 1, "resumed continuation complete");
        expect(children).toHaveLength(1);
        expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
        await s.save("supervisor-prepared-continued", history);
      } finally { await s.finish(handle); }
    });
  });

  it("defers continue-as-new until all 105 signaled turns fit the carried queue", async () => {
    const gate = deferred();
    let checks = 0;
    const runIds: string[] = [];
    await h.run({ checkRoomAgentSupervisorTurn: async () => {
      checks++; runIds.push(Context.current().info.workflowExecution!.runId);
      if (checks === 1) await gate.promise;
      return "SKIP";
    }, discardRoomAgentSupervisorTurn: async () => undefined }, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", supervisorInput({ pending: [item("0")], processedCount: 49 }));
      try {
        await until(() => checks === 1, "first queue check");
        for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(String(index)));
        // A final barrier makes every preceding signal visible before releasing
        // the first activity (no sleeps depending on machine speed).
        await signalProcessed(handle, ROOM_AGENT_ENQUEUE_SIGNAL, item("105"));
        gate.resolve();
        const history = await s.waitForContinue(handle);
        const carried = roomAgentSupervisorInputSchema.parse(continuedInput(history));
        expect(carried.pending).toEqual(Array.from({ length: 100 }, (_, i) => item(String(i + 6))));
        expect(runIds.filter(id => id === handle.firstExecutionRunId)).toHaveLength(6);
        await s.save("supervisor-bounded-carried-queue", history);
      } finally { gate.resolve(); }
    });
  }, 20_000);

  it("records pre-patch boolean settling without calling the continuation activity", async () => {
    const settle = vi.fn(async () => true);
    const prepare = vi.fn(async () => ({ state: "DONE" }));
    await h.run({ settleRoomAgentBackgroundMission: settle, prepareRoomAgentBackgroundContinuation: prepare }, async s => {
      const handle = await s.start("roomAgentSupervisorWorkflow", supervisorInput({ monitoringMissionIds: ["mission:legacy"] }));
      try {
        await h.advanceUntil(() => settle.mock.calls.length === 1, "legacy settle activity");
        await s.finish(handle, "supervisor-legacy-settle");
        expect(settle).toHaveBeenCalledOnce();
        expect(prepare).not.toHaveBeenCalled();
      } finally { await s.finish(handle); }
    }, true);
  });

  it.skipIf(recording)("replays every committed history with unmodified production workflows", async () => {
    const names = (await readdir(fixtures)).filter(name => name.endsWith(".json")).sort();
    expect(names.length).toBeGreaterThanOrEqual(9);
    const histories = await Promise.all(names.map(async name => ({ workflowId: name,
      history: temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(resolve(fixtures, name), "utf8"))) })));
    const types = new Set(histories.map(({ history }) => history.events![0]!.workflowExecutionStartedEventAttributes!.workflowType!.name));
    expect([...types].sort()).toEqual([
      "codexAppServerTurnWorkflow", "dotGoalWorkflow", "dummyTurnWorkflow", "memoryConsolidationWorkflow",
      "memoryMaintenanceWorkflow", "memoryMutationWorkflow", "roomAgentActionWorkflow", "roomAgentSupervisorWorkflow"
    ]);
    expect(names).toContain("supervisor-legacy-settle.json");
    let replayed = 0;
    for await (const result of Worker.runReplayHistories({ workflowBundle: h.current }, histories)) {
      expect(result.error, `Replay failed: ${result.workflowId}`).toBeUndefined();
      replayed++;
    }
    expect(replayed).toBe(names.length);
  }, 30_000);

  it.skipIf(recording)("rejects an incompatible timer addition with DeterminismViolationError", async () => {
    const history = temporal.api.history.v1.History.fromObject(JSON.parse(await readFile(resolve(fixtures, "dummy-turn-retry.json"), "utf8")));
    const incompatible = await bundleWorkflowCode({ workflowsPath: resolve(here, "incompatible-workflows.ts") });
    const results = [];
    for await (const result of Worker.runReplayHistories({ workflowBundle: incompatible }, [{ workflowId: "dummy-negative-control", history }])) results.push(result);
    expect(results).toHaveLength(1);
    expect(results[0]!.error).toBeInstanceOf(DeterminismViolationError);
  });
});
