import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { defaultPayloadConverter } from "@temporalio/common";
import type { TestWorkflowEnvironment } from "@temporalio/testing";
import type { WorkflowHandle } from "@temporalio/client";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState } from "../src/room-background-continuation.js";
import { createBountyTestEnv, createBountyWorker } from "./support/temporal-bounty.js";
import { recordHistory } from "./support/temporal-history.js";

let env: TestWorkflowEnvironment;
// Time skipping is global to a server. A fresh environment prevents another
// long-lived/continued run's clock locks from affecting the next scenario.
beforeEach(async () => { env = await createBountyTestEnv(); }, 120_000);
afterEach(async () => { await env?.teardown(); });

/** Bound activity/history synchronization in wall time without replacing workflow timers. */
async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 25_000) {
  const until = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > until) throw new Error("Real Temporal scenario did not reach its asserted boundary");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
const result = { status: "COMPLETED", message: "Verified", roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." } };
const item = (index: number, roomId = "room:real") => roomAgentSupervisorQueueItemSchema.parse({
  missionId: "mission:real", turn: { roomId, paneId: "pane:real", prompt: `Request ${index}`, artifactIds: [],
    agentRunId: `agent_run:${index}`, permissionMode: null, collaborationMode: "default", traceId: `trace:real-${index}` }
});

/** Run the production supervisor and always terminate its synthetic current execution chain. */
async function scenario(input: unknown, activities: Record<string, (...args: any[]) => any>, verify: (handle: WorkflowHandle) => Promise<void>, legacy = false, skipTime = true) {
  const taskQueue = `supervisor-real-${randomUUID()}`;
  const worker = await createBountyWorker(env, {
    taskQueue, activities, maxHeartbeatThrottleInterval: "20 milliseconds", defaultHeartbeatThrottleInterval: "10 milliseconds",
    ...(legacy ? { patchActivationCallback: ({ patchId }: { patchId: string }) => patchId !== "room-background-continuation-v1" } : {})
  });
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start("roomAgentSupervisorWorkflow", {
      workflowId: taskQueue, taskQueue, args: [roomAgentSupervisorInputSchema.parse(input)]
    });
    // Let the cold workflow isolate finish its first activation before the
    // time-skipping server advances. Otherwise a large initial bundle can be
    // overtaken by virtual workflow-task timeout timers on a busy CI host.
    await eventually(async () => (await handle.fetchHistory()).events?.some(event => !!event.workflowTaskCompletedEventAttributes) ?? false);
    // The SDK unlocks automatic time skipping while result() is outstanding.
    // These supervisors are deliberately long lived: assertions observe their
    // activities/history, then terminate the synthetic run in finally.
    // Client-driven enqueue/stop scenarios need no long workflow timers. Keep
    // their clock locked while a cold child starts; result() otherwise unlocks
    // global skipping before that child has reached its activity boundary.
    const completion = skipTime ? handle.result().catch(() => undefined) : undefined;
    try { await verify(handle); }
    finally {
      // Continue-as-new creates another run. Target the current chain head,
      // not the original run-bound handle, when cleaning up synthetic work.
      await env.client.workflow.getHandle(handle.workflowId).terminate("Synthetic test scenario completed").catch(() => undefined);
      await completion;
    }
  });
}

/** Fetch the original execution, even after the workflow handle follows continue-as-new. */
async function firstRunHistory(handle: WorkflowHandle) {
  // A handle without runId may point to the new run after rollover. Inspect the
  // original execution, whose terminal event carries the next run's input.
  const firstRunId = (handle as WorkflowHandle & { firstExecutionRunId?: string }).firstExecutionRunId;
  return (firstRunId ? env.client.workflow.getHandle(handle.workflowId, firstRunId) : handle).fetchHistory();
}

/** Decode the actual first-run continue-as-new payload using the SDK payload converter. */
async function continuedInput(handle: WorkflowHandle): Promise<any | null> {
  const history = await firstRunHistory(handle);
  const event = history.events?.find(event => event.workflowExecutionContinuedAsNewEventAttributes);
  const payload = event?.workflowExecutionContinuedAsNewEventAttributes?.input?.payloads?.[0];
  return payload ? defaultPayloadConverter.fromPayload(payload) : null;
}

/** Stub activity boundaries around the existing in-memory continuation implementation. */
function continuationDriver() {
  const c = continuationFixture();
  const childTurns: any[] = [];
  const finishes: any[] = [];
  const discards: any[] = [];
  const prepared: any[] = [];
  const activities = {
    prepareRoomAgentBackgroundContinuation: async (input: any) => {
      const preparedResult = await prepareBackgroundContinuation(input, c.store);
      prepared.push(preparedResult);
      return preparedResult;
    },
    checkRoomAgentSupervisorTurn: (input: any) => supervisorTurnState(input, c.store),
    discardRoomAgentSupervisorTurn: async ({ item: turn, reason }: any) => { await discardSupervisorTurn(turn, reason, c.store); discards.push({ item: turn, reason }); },
    finishRoomAgentSupervisorTurn: async (input: any) => { await finishSupervisorTurn(input, c.store); finishes.push(input); },
    runCodexAppServerTurn: async (turn: any) => {
      childTurns.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return result;
    }
  };
  return { ...c, activities, childTurns, finishes, discards, prepared,
    workflowInput: { roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] } };
}

describe("real sandbox supervisor continuation and signals", () => {
  it("executes allocation, send and verification exactly once in the original mission", async () => {
    const c = continuationDriver();
    c.activities.runCodexAppServerTurn = async (turn: any) => {
      c.childTurns.push(turn);
      expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      if (c.childTurns.length === 1) {
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        return { ...result, roomAgentOutcome: { ...result.roomAgentOutcome, pendingActionIds: ["action:send"] } } as any;
      }
      return result;
    };
    await scenario(c.workflowInput, c.activities, async handle => {
      await eventually(() => c.finishes.length === 1);
      expect(c.childTurns).toHaveLength(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
      await recordHistory(handle, "roomAgentSupervisorWorkflow-current");
    });
  }, 60_000);

  it.each(["stop", "follow-up"] as const)("retires a prepared continuation when %s arrives before its activity reply", async kind => {
    const c = continuationDriver();
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    let preparedRun: string | undefined;
    c.activities.prepareRoomAgentBackgroundContinuation = async (input: any) => {
      const prepared = await prepareBackgroundContinuation(input, c.store);
      if (prepared.state === "READY") preparedRun = prepared.item.turn.agentRunId ?? undefined;
      await barrier;
      return prepared;
    };
    await scenario(c.workflowInput, c.activities, async handle => {
      await eventually(() => !!preparedRun);
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      release();
      await eventually(() => c.discards.length > 0);
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, preparedRun)?.run.status).toBe("INTERRUPTED");
      if (kind === "stop") expect(c.childTurns).toHaveLength(0);
      else { await eventually(() => c.childTurns.length > 0); expect(c.childTurns[0].roomAgentOperatorRequest).toBe("Only inspect the room."); }
    });
  }, 60_000);

  it("carries a prepared continuation through continue-as-new and starts it once", async () => {
    const c = continuationDriver();
    await scenario({ ...c.workflowInput, processedCount: 50 }, c.activities, async handle => {
      let carried: any;
      await eventually(async () => { carried = await continuedInput(handle); return !!carried; });
      expect(carried.pending).toHaveLength(1);
      expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
      await eventually(() => c.finishes.length === 1);
      expect(c.childTurns).toHaveLength(1);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
    });
  }, 60_000);

  it("drains a flooded queue to the 100-item carry bound without dropping turns", async () => {
    let handle: WorkflowHandle;
    const checked: any[] = [];
    let first = true;
    const activities = {
      checkRoomAgentSupervisorTurn: async (turn: any) => {
        checked.push(turn);
        if (first) { first = false; await eventually(() => !!handle); for (let i = 1; i <= 105; i++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(i)); }
        return "SKIP";
      },
      discardRoomAgentSupervisorTurn: async () => undefined,
      finishRoomAgentSupervisorTurn: async () => undefined
    };
    await scenario({ roomId: "room:real", pending: [item(0)], processedCount: 49 }, activities, async started => {
      handle = started;
      let carried: any;
      await eventually(async () => { carried = await continuedInput(handle); return !!carried; });
      expect(carried.pending).toHaveLength(100);
      expect(carried.pending[0].turn.agentRunId).toBe("agent_run:6");
      expect(carried.pending[99].turn.agentRunId).toBe("agent_run:105");
      expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
      expect(checked.slice(0, 6).map(turn => turn.turn.agentRunId)).toEqual(Array.from({ length: 6 }, (_, i) => `agent_run:${i}`));
    });
  }, 60_000);

  it.each([false, true])("executes enqueue and stop cancellation in the real %s legacy branch", async legacy => {
    const started: any[] = [], finished: any[] = [], discarded: any[] = [];
    const activities = {
      checkRoomAgentSupervisorTurn: async () => "READY",
      markRoomAgentMissionStarted: async (input: any) => { started.push(input); },
      markRoomAgentMissionFinished: async (input: any) => { finished.push(input); },
      markRoomAgentMissionContinued: async () => undefined,
      finishRoomAgentSupervisorTurn: async (input: any) => { finished.push(input); },
      discardRoomAgentSupervisorTurn: async (input: any) => { discarded.push(input); },
      runCodexAppServerTurn: async (turn: any) => {
        started.push(turn);
        for (;;) { Context.current().heartbeat(); await Context.current().sleep(10); }
      }
    };
    await scenario({ roomId: "room:real" }, activities, async handle => {
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(0));
      await eventually(() => started.some(value => value.agentRunId === "agent_run:0"));
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:real", reason: "Stop test" });
      await eventually(() => finished.length > 0);
      expect(finished[0].status).toBe("INTERRUPTED");
      expect(finished[0].statusReason).toBe("Stop test");
      if (!legacy) expect(discarded).toHaveLength(1);
      if (legacy) await recordHistory(handle, "roomAgentSupervisorWorkflow-pre-patch");
    }, legacy, false);
  }, 60_000);

  it.each([false, true])("rolls over after 250 real one-second polling timers with state intact (legacy=%s)", async legacy => {
    let polls = 0;
    const activities = {
      prepareRoomAgentBackgroundContinuation: async () => { polls++; return { state: "WAITING" }; },
      settleRoomAgentBackgroundMission: async () => { polls++; return false; }
    };
    await scenario({ roomId: "room:real", monitoringMissionIds: ["mission:real"], processedCount: 7 }, activities, async handle => {
      await eventually(() => polls >= 250, 65_000).catch(error => {
        throw new Error(`Real polling boundary not reached: ${polls}/250 activity executions`, { cause: error });
      });
      let carried: any;
      await eventually(async () => { carried = await continuedInput(handle); return !!carried; });
      expect(polls).toBeGreaterThanOrEqual(250);
      const events = (await firstRunHistory(handle)).events ?? [];
      const timers = events.filter(event => event.timerStartedEventAttributes);
      const fired = events.filter(event => event.timerFiredEventAttributes);
      const pollActivity = legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation";
      const scheduled = events.filter(event => event.activityTaskScheduledEventAttributes?.activityType?.name === pollActivity);
      expect(timers, "The original run must schedule 250 real polling timers").toHaveLength(250);
      expect(fired, "All 250 polling timers must actually fire before rollover").toHaveLength(250);
      expect(scheduled, "Each timer must drive one polling activity in the original run").toHaveLength(250);
      const startedById = new Map(timers.map(event => [event.eventId?.toString(), event]));
      for (const [index, event] of fired.entries()) {
        const firedTimer = event.timerFiredEventAttributes!;
        const started = startedById.get(firedTimer.startedEventId?.toString());
        expect(started, `Polling timer ${index + 1} must refer to a recorded TIMER_STARTED`).toBeDefined();
        const attributes = started?.timerStartedEventAttributes;
        expect(attributes?.timerId).toBe(firedTimer.timerId);
        expect(attributes?.startToFireTimeout?.seconds?.toString(), "Polling timeout must remain one second").toBe("1");
        expect(attributes?.startToFireTimeout?.nanos ?? 0).toBe(0);
        expect(Number(event.eventId?.toString())).toBeLessThan(Number(scheduled[index]!.eventId?.toString()));
        if (index + 1 < fired.length) {
          expect(Number(scheduled[index]!.eventId?.toString())).toBeLessThan(Number(fired[index + 1]!.eventId?.toString()));
        }
      }
      expect(carried.monitoringMissionIds).toEqual(["mission:real"]);
      expect(carried.pending).toEqual([]);
      expect(carried.processedCount).toBe(legacy ? 7 : 0);
      if (legacy) expect(carried.roomId).toBe("room:real");
    }, legacy);
  }, 90_000);

  it.each([false, true])("continues after the fiftieth processed turn, preserving an empty valid queue (legacy=%s)", async legacy => {
    let completed = 0;
    const activities = {
      checkRoomAgentSupervisorTurn: async () => "READY",
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionContinued: async () => undefined,
      markRoomAgentMissionFinished: async () => { completed++; },
      finishRoomAgentSupervisorTurn: async () => { completed++; },
      runCodexAppServerTurn: async () => result
    };
    await scenario({ roomId: "room:real", pending: [item(0)], processedCount: 49 }, activities, async handle => {
      let carried: any;
      await eventually(async () => { carried = await continuedInput(handle); return !!carried; });
      expect(completed).toBe(1);
      expect(carried.processedCount).toBe(0);
      expect(carried.pending).toEqual([]);
      expect(carried.monitoringMissionIds).toEqual([]);
      expect(() => roomAgentSupervisorInputSchema.parse(carried)).not.toThrow();
    }, legacy);
  }, 60_000);

  it("uses the legacy boolean settle contract rather than the current continuation activity", async () => {
    let settled = 0, prepared = 0;
    await scenario({ roomId: "room:real", monitoringMissionIds: ["mission:real"] }, {
      settleRoomAgentBackgroundMission: async () => { settled++; return true; },
      prepareRoomAgentBackgroundContinuation: async () => { prepared++; return { state: "DONE" }; }
    }, async () => {
      await eventually(() => settled === 1);
      expect(prepared).toBe(0);
    }, true);
  }, 60_000);
});
