import { describe, expect, it } from "vitest";
import { ApplicationFailure, TimeoutFailure, TimeoutType } from "@temporalio/common";
import { Context } from "@temporalio/activity";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema } from "@space/contracts";
import { continuationFixture } from "./room-continuation-fixture.js";
import { discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation,
  supervisorTurnState } from "../src/room-background-continuation.js";
import { withTemporal, jsonPayload, waitFor } from "./support/temporal-harness.js";


// These are real SDK workflows and children. Only their external activity boundary
// is replaced; neither @temporalio/workflow nor the supervisor is mocked.
const roomId = "room:temporal-supervisor";
const completed = { status: "COMPLETED", message: "Verified", roomAgentOutcome: {
  status: "VERIFIED", executedActionCount: 1, statusReason: "Verified remaining request." } };
function item(index: number, missionId = "mission:supervisor") {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId, turn: {
    roomId, paneId: "pane:supervisor", prompt: `Request ${index}`, agentRunId: `agent_run:supervisor-${index}`,
    roomAgentMissionId: missionId, traceId: `trace:supervisor-${index}` } });
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
async function until(predicate: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 30_000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error(`Timed out: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function timerReady(handle: any, count = 1) {
  await until(async () => ((await handle.fetchHistory()).events?.filter((e: any) => e.timerStartedEventAttributes).length ?? 0) >= count, "supervisor timer");
}
async function signalProcessed(client: any, handle: any, name: string, payload: unknown) {
  await handle.signal(name, payload);
  // The SDK's built-in query uses the server's strongly consistent QueryWorkflow
  // RPC. It observes the preceding accepted signal without requiring a new
  // persisted WorkflowTaskStarted event (signal activations may share a task).
  // No query handler or test hook is added to production workflows.
  await client.connection.withDeadline(Date.now() + 15_000, () => handle.query("__stack_trace"));
}
async function withReleasedGate<T>(value: ReturnType<typeof gate>, run: () => Promise<T>): Promise<T> {
  try { return await run(); }
  finally { value.release(); }
}
async function waitAtGate(value: ReturnType<typeof gate>) {
  await Promise.race([value.promise, Context.current().cancelled]);
}

function stateDriver() {
  const c = continuationFixture();
  const seen: any[] = [], finished: any[] = [], discarded: any[] = [];
  const activities = {
    prepareRoomAgentBackgroundContinuation: (input: any) => prepareBackgroundContinuation(input, c.store),
    checkRoomAgentSupervisorTurn: (value: any) => supervisorTurnState(value, c.store),
    discardRoomAgentSupervisorTurn: (value: any) => {
      discarded.push(value);
      return discardSupervisorTurn(value.item, value.reason, c.store, value.errorCode);
    },
    finishRoomAgentSupervisorTurn: (value: any) => {
      finished.push(value);
      return finishSupervisorTurn(value, c.store);
    },
    runCodexAppServerTurn: async (turn: any) => {
      seen.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return completed;
    }
  };
  return { ...c, seen, finished, discarded, activities };
}
const input = (extra: Record<string, unknown> = {}) => roomAgentSupervisorInputSchema.parse({ roomId, ...extra });
async function start(ctx: any, value: unknown) {
  return ctx.client.workflow.start("roomAgentSupervisorWorkflow", {
    workflowId: `supervisor-${crypto.randomUUID()}`, taskQueue: ctx.taskQueue, args: [value] });
}

describe("room supervisor in the Temporal sandbox", () => {
  it("runs allocation → send → verification in one mission using real child workflows", async () => {
    const c = stateDriver();
    c.activities.runCodexAppServerTurn = async turn => {
      c.seen.push(turn);
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      if (c.seen.length === 1) {
        expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once",
          actionType: "SEND", evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        return { ...completed, roomAgentOutcome: { ...completed.roomAgentOutcome, pendingActionIds: ["action:send"] } };
      }
      return completed;
    };
    await withTemporal({ activities: c.activities }, async ctx => {
      const handle = await start(ctx, input({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }));
      await timerReady(handle);
      await ctx.env.sleep("1 second");
      await waitFor(() => c.seen.length === 1);
      await timerReady(handle, 2);
      await ctx.env.sleep("2 seconds");
      await waitFor(() => c.finished.length === 1);
      expect(c.seen).toHaveLength(2);
      expect(c.store.listRoomAgentActions(c.initial.mission.id).filter(a => a.actionType === "SEND")).toHaveLength(1);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
      const history = await handle.fetchHistory();
      expect(history.events?.filter((e: any) => e.childWorkflowExecutionStartedEventAttributes)).toHaveLength(2);
      await handle.terminate();
    });
  }, 60_000);

  it.each([
    ["plain error", () => { throw ApplicationFailure.nonRetryable("child failed", "Error"); }, "ROOM_AGENT_SUPERVISOR_FAILED"],
    ["serialized Temporal timeout cause", () => { throw ApplicationFailure.create({ message: "child failed", type: "Error", nonRetryable: true, cause: new TimeoutFailure("timed out", undefined, TimeoutType.START_TO_CLOSE) }); }, "ROOM_AGENT_SUPERVISOR_TIMEOUT"],
    ["application cause", () => { throw ApplicationFailure.nonRetryable("child failed", "CODEX_APP_SERVER_TURN_TIMEOUT"); }, "CODEX_APP_SERVER_TURN_TIMEOUT"]
  ])("records %s as FAILED rather than superseded", async (_name, fail, code) => {
    const c = stateDriver();
    c.activities.runCodexAppServerTurn = async () => fail();
    await withTemporal({ activities: c.activities }, async ctx => {
      const handle = await start(ctx, input({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }));
      await timerReady(handle); await ctx.env.sleep("1 second");
      await waitFor(() => c.finished.length === 1);
      expect(c.finished[0]).toMatchObject({ status: "FAILED", errorCode: code });
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("FAILED");
      expect(c.discarded[0].errorCode).toBe(code);
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, c.discarded[0].item.turn.agentRunId)?.run)
        .toMatchObject({ status: "FAILED", errorCode: code });
      await handle.terminate();
    });
  }, 60_000);

  it.each(["stop", "follow-up"])("retires a prepared run when %s wins the activity-reply race", async kind => {
    const c = stateDriver(), prepared = gate();
    let ready: any;
    c.activities.prepareRoomAgentBackgroundContinuation = async value => {
      ready = await prepareBackgroundContinuation(value, c.store);
      await waitAtGate(prepared);
      return ready;
    };
    await withTemporal({ activities: c.activities }, async ctx => withReleasedGate(prepared, async () => {
      const handle = await start(ctx, input({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] }));
      await timerReady(handle); await ctx.env.sleep("1 second");
      await waitFor(() => Boolean(ready));
      expect(ready.state).toBe("READY");
      if (kind === "stop") {
        c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
        await signalProcessed(ctx.client, handle, ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
      } else {
        const followUp = c.enqueue("follow-up", "Only inspect the room.");
        await signalProcessed(ctx.client, handle, ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
      }
      prepared.release();
      await waitFor(() => c.discarded.length > 0);
      expect(c.store.getRoomAgentTurn(c.initial.mission.id, ready.item.turn.agentRunId)?.run.status).toBe("INTERRUPTED");
      if (kind === "stop") expect(c.seen).toHaveLength(0);
      else {
        await waitFor(() => c.seen.length > 0);
        expect(c.seen[0].roomAgentOperatorRequest).toBe("Only inspect the room.");
      }
      await handle.terminate();
    }));
  }, 60_000);

  it("carries a prepared continuation at 50 processed items and starts it exactly once", async () => {
    const c = stateDriver();
    await withTemporal({ activities: c.activities }, async ctx => {
      const handle = await start(ctx, input({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id], processedCount: 50 }));
      const original = ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      await timerReady(original); await ctx.env.sleep("1 second");
      await waitFor(() => c.finished.length === 1);
      const history = await original.fetchHistory();
      const event = history.events?.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes);
      expect(event).toBeDefined();
      const carried = roomAgentSupervisorInputSchema.parse(jsonPayload(event!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
      expect(carried.pending).toHaveLength(1);
      expect(carried.processedCount).toBe(0);
      expect(carried.monitoringMissionIds).toEqual([c.initial.mission.id]);
      expect(c.seen).toHaveLength(1);
      expect(c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status).toBe("COMPLETED");
      expect(history.events?.filter((e: any) => e.childWorkflowExecutionStartedEventAttributes)).toHaveLength(0);
      await handle.terminate();
    });
  }, 60_000);

  it.each([false, true])("continues after the fiftieth processed turn with its remaining queue (legacy=%s)", async legacyPatch => {
    const seen: string[] = [], finished: any[] = [];
    const monitoringMissionIds = ["mission:unrelated-monitor"];
    const activities = {
      checkRoomAgentSupervisorTurn: async () => "READY",
      prepareRoomAgentBackgroundContinuation: async () => ({ state: "WAITING" }),
      settleRoomAgentBackgroundMission: async () => false,
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionFinished: async (value: any) => { finished.push(value); },
      finishRoomAgentSupervisorTurn: async (value: any) => { finished.push(value); },
      runCodexAppServerTurn: async (turn: any) => { seen.push(turn.agentRunId); return completed; }
    };
    await withTemporal({ activities, legacyPatch }, async ctx => {
      const handle = await start(ctx, input({ processedCount: 49, monitoringMissionIds,
        pending: [item(0, "mission:first"), item(1, "mission:second")] }));
      const original = ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      await waitFor(() => finished.length === 2);
      const history = await original.fetchHistory();
      const event = history.events?.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes);
      expect(event).toBeDefined();
      const carried = roomAgentSupervisorInputSchema.parse(jsonPayload(event!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
      expect(carried.roomId).toBe(roomId);
      expect(carried.monitoringMissionIds).toEqual(monitoringMissionIds);
      expect(carried.pending).toEqual([item(1, "mission:second")]);
      expect(carried.processedCount).toBe(0);
      expect(carried.interrupted).toEqual([]);
      const resumed = await handle.fetchHistory();
      const resumedInput = resumed.events?.find((e: any) => e.workflowExecutionStartedEventAttributes)
        ?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
      expect(roomAgentSupervisorInputSchema.parse(jsonPayload(resumedInput!))).toEqual(carried);
      expect(seen).toEqual([item(0).turn.agentRunId, item(1).turn.agentRunId]);
      expect(history.events?.filter((e: any) => e.childWorkflowExecutionStartedEventAttributes)).toHaveLength(1);
      await handle.terminate();
    });
  }, 60_000);

  it("carries pending, interrupted and monitored state together across continue-as-new", async () => {
    const blocked = gate();
    let checks = 0;
    const finished: any[] = [];
    const activities = {
      checkRoomAgentSupervisorTurn: async () => { checks++; if (checks === 1) await waitAtGate(blocked); return "SKIP"; },
      discardRoomAgentSupervisorTurn: async () => undefined,
      finishRoomAgentSupervisorTurn: async (value: any) => { finished.push(value); },
      prepareRoomAgentBackgroundContinuation: async () => ({ state: "WAITING" })
    };
    await withTemporal({ activities }, async ctx => withReleasedGate(blocked, async () => {
      const handle = await start(ctx, input({ processedCount: 49,
        pending: [item(0, "mission:active"), item(1, "mission:stop"), item(2, "mission:pending")],
        monitoringMissionIds: ["mission:monitor"] }));
      const original = ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      await waitFor(() => checks === 1);
      await signalProcessed(ctx.client, handle, ROOM_AGENT_STOP_SIGNAL, { missionId: "mission:stop", reason: "Only stop this mission" });
      blocked.release();
      await waitFor(() => checks === 2 && finished.length === 1);
      const history = await original.fetchHistory();
      const event = history.events?.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes);
      expect(event).toBeDefined();
      const carried = roomAgentSupervisorInputSchema.parse(jsonPayload(event!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
      expect(carried.pending).toEqual([item(2, "mission:pending")]);
      expect(carried.interrupted).toEqual([{ item: item(1, "mission:stop"), reason: "Only stop this mission" }]);
      expect(carried.monitoringMissionIds).toEqual(["mission:monitor"]);
      expect(finished[0]).toMatchObject({ status: "INTERRUPTED", item: item(1, "mission:stop") });
      await handle.terminate();
    }));
  }, 60_000);

  it("characterizes legacy ignored input and lost queued interruptions at the 50-turn rollover", async () => {
    // Compatibility characterization, NOT a correctness claim: the unpatched
    // production branch writes interrupted: [] and drops this queued stop.
    const started = gate();
    let starting = false;
    const finished: any[] = [];
    const activities = {
      markRoomAgentMissionStarted: async () => { starting = true; await waitAtGate(started); },
      markRoomAgentMissionFinished: async (value: any) => { finished.push(value); },
      runCodexAppServerTurn: async () => { throw Error("Cancelled child must not start"); }
    };
    await withTemporal({ activities, legacyPatch: true }, async ctx => withReleasedGate(started, async () => {
      const handle = await start(ctx, input({ processedCount: 49,
        pending: [item(0, "mission:active"), item(1, "mission:queued-stop")],
        interrupted: [{ item: item(2, "mission:already-interrupted"), reason: "Carried stop" }] }));
      const original = ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      await waitFor(() => starting);
      await signalProcessed(ctx.client, handle, ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop both" });
      started.release();
      await until(async () => Boolean((await original.fetchHistory()).events?.some((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)), "legacy rollover");
      const history = await original.fetchHistory();
      const event = history.events!.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)!;
      const carried = roomAgentSupervisorInputSchema.parse(jsonPayload(event.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
      expect(carried.pending).toEqual([]);
      expect(carried.interrupted).toEqual([]);
      await ctx.env.sleep("1 second");
      expect(finished).toEqual([expect.objectContaining({ missionId: "mission:active", status: "INTERRUPTED" })]);
      await handle.terminate();
    }));
  }, 60_000);

  it("does not lose a 105-signal queue while bringing carried state under the 100-item schema bound", async () => {
    const checked: string[] = [], blocked = gate();
    const activities = {
      checkRoomAgentSupervisorTurn: async (value: any) => {
        checked.push(value.turn.agentRunId);
        if (checked.length === 1) await waitAtGate(blocked);
        return "SKIP";
      }, discardRoomAgentSupervisorTurn: async () => undefined
    };
    await withTemporal({ activities }, async ctx => withReleasedGate(blocked, async () => {
      const handle = await start(ctx, input({ pending: [item(0)], processedCount: 49 }));
      const original = ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      await waitFor(() => checked.length === 1);
      for (let index = 1; index <= 105; index++) await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(index));
      // The final signal activation is a barrier before releasing the activity.
      await signalProcessed(ctx.client, handle, ROOM_AGENT_ENQUEUE_SIGNAL, item(105));
      blocked.release();
      await waitFor(() => checked.length === 106, "all 106 queued turns drained", 30_000);
      const history = await original.fetchHistory();
      const event = history.events?.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes);
      expect(event).toBeDefined();
      const carried = roomAgentSupervisorInputSchema.parse(jsonPayload(event!.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
      expect(carried.pending).toHaveLength(100);
      expect(history.events?.filter((e: any) =>
        e.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn")).toHaveLength(6);
      expect(new Set(checked).size).toBe(106);
      expect(checked).toEqual(Array.from({ length: 106 }, (_, index) => item(index).turn.agentRunId));
      await handle.terminate();
    }));
  }, 120_000);

  it.each([false, true])("validates enqueue signals, deduplicates pending work and interrupts active and queued turns (legacy=%s)", async legacyPatch => {
    const running: string[] = [], finished: any[] = [], discarded: any[] = [];
    const activities = {
      checkRoomAgentSupervisorTurn: async () => "READY",
      markRoomAgentMissionStarted: async () => undefined,
      markRoomAgentMissionFinished: async (value: any) => { finished.push(value); },
      markRoomAgentMissionContinued: async () => undefined,
      finishRoomAgentSupervisorTurn: async (value: any) => { finished.push(value); },
      discardRoomAgentSupervisorTurn: async (value: any) => { discarded.push(value); },
      runCodexAppServerTurn: async (turn: any) => {
        running.push(turn.agentRunId);
        // Heartbeats deliver a real activity cancellation to the real child.
        for (;;) {
          Context.current().heartbeat();
          await Context.current().sleep(10);
        }
      }
    };
    await withTemporal({ activities, legacyPatch }, async ctx => {
      const handle = await start(ctx, input({ pending: [item(0, "mission:active")] }));
      await waitFor(() => running.length === 1);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { malformed: true });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...item(99), turn: { ...item(99).turn, roomId: "room:wrong" } });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(1, "mission:queued"));
      await signalProcessed(ctx.client, handle, ROOM_AGENT_ENQUEUE_SIGNAL, item(1, "mission:queued"));
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Operator stopped both" });
      await waitFor(() => finished.length === 2, "both interruptions", 20_000);
      expect(running).toEqual([item(0).turn.agentRunId]);
      expect(finished.every(value => value.status === "INTERRUPTED")).toBe(true);
      expect(finished.map(value => value.missionId ?? value.item.missionId).sort())
        .toEqual(["mission:active", "mission:queued"]);
      expect(finished.every(value => value.statusReason === "Operator stopped both")).toBe(true);
      if (!legacyPatch) expect(discarded).toHaveLength(2);
      const history = await handle.fetchHistory();
      expect(history.events?.filter((e: any) => e.childWorkflowExecutionStartedEventAttributes)).toHaveLength(1);
      await handle.terminate();
    });
  }, 60_000);

  it("retains a paused turn and retries it after a durable one-second condition timer", async () => {
    const queued = item(201, "mission:paused");
    const checked: any[] = [], executed: any[] = [], finished: any[] = [];
    const activities = {
      checkRoomAgentSupervisorTurn: async (value: any) => {
        checked.push(value);
        return checked.length === 1 ? "PAUSED" : "READY";
      },
      runCodexAppServerTurn: async (turn: any) => { executed.push(turn); return completed; },
      finishRoomAgentSupervisorTurn: async (value: any) => { finished.push(value); }
    };
    await withTemporal({ activities }, async ctx => {
      const handle = await start(ctx, input({ pending: [queued] }));
      await timerReady(handle);
      await ctx.env.sleep("1 second");
      await waitFor(() => finished.length === 1, "paused turn resumed and finished");
      expect(checked).toEqual([queued, queued]);
      expect(executed).toEqual([queued.turn]);
      expect(finished[0]).toMatchObject({ item: queued, status: "COMPLETED" });
      const events = (await handle.fetchHistory()).events ?? [];
      const timers = events.filter((e: any) => e.timerStartedEventAttributes);
      expect(timers).toHaveLength(1);
      expect(Number(timers[0]!.timerStartedEventAttributes!.startToFireTimeout!.seconds)).toBe(1);
      const fired = events.find((e: any) => e.timerFiredEventAttributes)!;
      expect(fired).toBeDefined();
      const checks = events.filter((e: any) => e.activityTaskScheduledEventAttributes?.activityType?.name === "checkRoomAgentSupervisorTurn");
      expect(checks).toHaveLength(2);
      expect(Number(checks[0]!.eventId)).toBeLessThan(Number(timers[0]!.eventId));
      expect(Number(fired.eventId)).toBeLessThan(Number(checks[1]!.eventId));
      expect(events.filter((e: any) => e.childWorkflowExecutionStartedEventAttributes)).toHaveLength(1);
      await handle.terminate();
    });
  }, 60_000);

  it.each([false, true])("stops monitoring a finished mission (legacy=%s)", async legacyPatch => {
    const calls: string[] = [];
    const activities = {
      prepareRoomAgentBackgroundContinuation: async () => { calls.push("prepare"); return { state: "DONE" }; },
      settleRoomAgentBackgroundMission: async () => { calls.push("settle"); return true; }
    };
    await withTemporal({ activities, legacyPatch }, async ctx => {
      const handle = await start(ctx, input({ monitoringMissionIds: ["mission:finished"] }));
      await timerReady(handle); await ctx.env.sleep("1 second");
      await waitFor(() => calls.length === 1);
      await ctx.env.sleep("5 seconds");
      expect(calls).toEqual([legacyPatch ? "settle" : "prepare"]);
      const history = await handle.fetchHistory();
      expect(history.events?.filter((e: any) => e.timerStartedEventAttributes)).toHaveLength(1);
      await handle.terminate();
    });
  }, 60_000);

  it.each([false, true])("uses 1-second timers and continues at 250 monitoring polls (legacy=%s)", async legacyPatch => {
    let polls = 0;
    const activities = {
      prepareRoomAgentBackgroundContinuation: async () => { polls++; return { state: "WAITING" }; },
      settleRoomAgentBackgroundMission: async () => { polls++; return false; }
    };
    await withTemporal({ activities, legacyPatch, freshServer: true, timeoutMs: 100_000 }, async ctx => {
      const handle = await start(ctx, input({ monitoringMissionIds: ["mission:monitor"], processedCount: 7 }));
      const original = ctx.client.workflow.getHandle(handle.workflowId, handle.firstExecutionRunId);
      await timerReady(original);
      // Let the test server advance through the actual timers and activity
      // completions, rather than issuing 250 wall-clock polling RPCs.
      await ctx.env.sleep("5 minutes");
      await waitFor(() => polls >= 251, "monitoring continues in the next execution");
      await until(async () => Boolean((await original.fetchHistory()).events?.some((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)), "250-poll continue-as-new");
      const history = await original.fetchHistory();
      const events = history.events ?? [];
      const timers = events.filter((e: any) => e.timerStartedEventAttributes);
      expect(timers).toHaveLength(250);
      for (const timer of timers) expect(Number(timer.timerStartedEventAttributes!.startToFireTimeout!.seconds)).toBe(1);
      const activityNames = events.filter((e: any) => e.activityTaskScheduledEventAttributes)
        .map((e: any) => e.activityTaskScheduledEventAttributes.activityType.name);
      expect(activityNames).toEqual(Array(250).fill(legacyPatch ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation"));
      const event = events.find((e: any) => e.workflowExecutionContinuedAsNewEventAttributes)!;
      const carried = roomAgentSupervisorInputSchema.parse(jsonPayload(event.workflowExecutionContinuedAsNewEventAttributes!.input!.payloads![0]!));
      expect(carried).toMatchObject({ roomId, pending: [], monitoringMissionIds: ["mission:monitor"], processedCount: legacyPatch ? 7 : 0 });
      const resumed = await handle.fetchHistory();
      const resumedInput = resumed.events?.find((e: any) => e.workflowExecutionStartedEventAttributes)
        ?.workflowExecutionStartedEventAttributes?.input?.payloads?.[0];
      expect(roomAgentSupervisorInputSchema.parse(jsonPayload(resumedInput!))).toEqual(carried);
      await handle.terminate();
    });
  }, 120_000);
});
