import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError } from "@temporalio/client";
import { ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL } from "@space/contracts";
import { Sandbox, continuedInput, deferred, eventually, waitForTimer } from "./support/temporal-sandbox.js";
import { queueItem, roomId, supervisorInput, verified } from "./support/temporal-inputs.js";

let sandbox: Sandbox;
// Each case owns its server clock and namespace, including child workflow IDs.
beforeEach(async () => { sandbox = await Sandbox.create(); }, 60_000);
afterEach(async () => { await sandbox?.close(); });

describe.each([false, true])("real supervisor (legacy=%s)", legacy => {
  it("handles enqueue/deduplication, pending stops and cancellation of an active child", async () => {
    const active = queueItem("active");
    const pending = queueItem("pending");
    const next = queueItem("next");
    const entered = deferred();
    const childRuns: string[] = [];
    const finishes: any[] = [];
    let cancelled = false;
    await sandbox.run({
      checkRoomAgentSupervisorTurn: () => "READY",
      discardRoomAgentSupervisorTurn: () => undefined,
      finishRoomAgentSupervisorTurn: input => finishes.push(input),
      markRoomAgentMissionStarted: () => undefined,
      markRoomAgentMissionFinished: input => finishes.push(input),
      runCodexAppServerTurn: async input => {
        childRuns.push(input.agentRunId);
        if (input.agentRunId !== active.turn.agentRunId) return verified;
        const context = Context.current();
        const heartbeat = setInterval(() => context.heartbeat(), 10);
        context.heartbeat();
        entered.resolve();
        try { await context.cancelled; }
        finally { cancelled = true; clearInterval(heartbeat); }
      }
    }, async () => {
      const handle = await sandbox.start("roomAgentSupervisorWorkflow", supervisorInput({ pending: [active] }));
      await entered.promise;
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, pending);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, pending);
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { ...queueItem("wrong-room"), turn: { ...next.turn, roomId: "room:other" } });
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: pending.missionId, reason: "Pending stopped" });
      await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, next);
      await handle.signal(ROOM_AGENT_STOP_SIGNAL, { missionId: active.missionId, reason: "Active stopped" });
      await eventually(() => finishes, value => value.length === 3, "stopped and completed missions");
      expect(cancelled).toBe(true);
      expect(childRuns).toEqual([active.turn.agentRunId, next.turn.agentRunId]);
      const statuses = finishes.map(finish => ({
        missionId: legacy ? finish.missionId : finish.item.missionId,
        status: finish.status, reason: finish.statusReason
      }));
      expect(statuses).toEqual(expect.arrayContaining([
        { missionId: active.missionId, status: "INTERRUPTED", reason: "Active stopped" },
        { missionId: pending.missionId, status: "INTERRUPTED", reason: "Pending stopped" },
        { missionId: next.missionId, status: "COMPLETED", reason: verified.roomAgentOutcome.statusReason }
      ]));
      const children = (await handle.fetchHistory()).events!.filter(event => event.childWorkflowExecutionStartedEventAttributes);
      expect(children).toHaveLength(2);
    }, { legacy });
  }, 30_000);

  it("uses a real one-second condition timer and the branch's correct monitoring activity", async () => {
    const calls: string[] = [];
    await sandbox.run({
      settleRoomAgentBackgroundMission: input => { expect(input).toEqual({ roomId, missionId: "mission:monitor" }); calls.push("legacy"); return true; },
      prepareRoomAgentBackgroundContinuation: input => {
        expect(input).toMatchObject({ roomId, missionId: "mission:monitor" });
        expect(input.continuationId).toMatch(/^[0-9a-f-]{36}$/);
        calls.push("current"); return { state: "DONE" };
      }
    }, async () => {
      const handle = await sandbox.start("roomAgentSupervisorWorkflow", supervisorInput({ monitoringMissionIds: ["mission:monitor"] }));
      const history = await waitForTimer(handle);
      const timer = history.events!.find(event => event.timerStartedEventAttributes)!.timerStartedEventAttributes!;
      expect(Number(timer.startToFireTimeout!.seconds)).toBe(1);
      expect(calls).toEqual([]);
      await sandbox.env.sleep("1 second");
      await eventually(() => calls.length, count => count === 1, "monitoring poll");
      expect(calls).toEqual([legacy ? "legacy" : "current"]);
      const markers = (await handle.fetchHistory()).events!.flatMap(event => event.markerRecordedEventAttributes ?? []);
      if (legacy) expect(markers.filter(marker => marker.markerName === "core_patch")).toHaveLength(0);
      else expect(markers.some(marker => marker.markerName === "core_patch")).toBe(true);
    }, { legacy });
  }, 30_000);

  it("continues after fifty real processed turns, carries the queue and monitoring, and starts the successor once", async () => {
    const items = Array.from({ length: 51 }, (_, index) => queueItem(`fifty-${index}`));
    const completed: string[] = [];
    await sandbox.run({
      checkRoomAgentSupervisorTurn: () => "READY",
      markRoomAgentMissionStarted: () => undefined,
      markRoomAgentMissionContinued: () => undefined,
      markRoomAgentMissionFinished: () => undefined,
      finishRoomAgentSupervisorTurn: () => undefined,
      runCodexAppServerTurn: async input => {
        completed.push(input.agentRunId);
        return verified;
      },
      prepareRoomAgentBackgroundContinuation: () => ({ state: "DONE" }),
      settleRoomAgentBackgroundMission: () => true
    }, async () => {
      const handle = await sandbox.start("roomAgentSupervisorWorkflow", supervisorInput({
        pending: items, monitoringMissionIds: ["mission:carried"]
      }), { followRuns: false });
      // result() enables SDK time skipping while waiting for this run's CAN.
      await expect(handle.result()).rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
      const carried = await continuedInput(handle);
      expect(carried.input).toEqual(supervisorInput({ pending: [items[50]], monitoringMissionIds: ["mission:carried"], processedCount: 0 }));
      await eventually(() => completed.length, count => count === 51, "successor's carried turn");
      expect(completed).toEqual(items.map(item => item.turn.agentRunId));
      const successor = sandbox.env.client.workflow.getHandle(handle.workflowId, carried.runId);
      const started = (await successor.fetchHistory()).events![0]!.workflowExecutionStartedEventAttributes!;
      expect(started.continuedExecutionRunId).toBeTruthy();
    }, { legacy, timeoutMs: 45_000 });
  }, 60_000);

  it("continues after exactly 250 one-second polls, preserving monitoring and the branch's counter contract", async () => {
    let polls = 0;
    const poll = async (input: { roomId: string; missionId: string }) => {
      expect(input).toMatchObject({ roomId, missionId: "mission:carried-polls" });
      polls++;
      return legacy ? polls >= 251 : { state: polls >= 251 ? "DONE" : "WAITING" };
    };
    await sandbox.run({
      [legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation"]: poll
    }, async () => {
      const handle = await sandbox.start("roomAgentSupervisorWorkflow", supervisorInput({
        monitoringMissionIds: ["mission:carried-polls"], processedCount: 7
      }), { followRuns: false });
      await waitForTimer(handle);
      await sandbox.env.sleep("252 seconds");
      const carried = await continuedInput(handle);
      expect(carried.input).toEqual(supervisorInput({
        monitoringMissionIds: ["mission:carried-polls"], processedCount: legacy ? 7 : 0
      }));
      expect(carried.history.events!.filter(event => event.timerFiredEventAttributes)).toHaveLength(250);
      expect(carried.history.events!.filter(event => event.activityTaskCompletedEventAttributes)).toHaveLength(250);
      expect(polls).toBeGreaterThanOrEqual(250);
      expect(polls).toBeLessThanOrEqual(251);
      // The successor must resume the same monitor rather than silently dropping it.
      const nextRun = sandbox.env.client.workflow.getHandle(handle.workflowId, carried.runId);
      await waitForTimer(nextRun);
      if (polls < 251) await sandbox.env.sleep("1 second");
      await eventually(() => polls, count => count === 251, `successor poll (legacy=${legacy})`);
      expect(polls).toBe(251);
    }, { legacy });
  }, 60_000);
});

it("carries interrupted turns into the next current-branch run without dropping or repeating them", async () => {
  const first = queueItem("interrupted-first");
  const second = queueItem("interrupted-second");
  const pending = queueItem("carried-pending");
  const finished: string[] = [];
  await sandbox.run({
    discardRoomAgentSupervisorTurn: () => undefined,
    finishRoomAgentSupervisorTurn: async ({ item }) => {
      finished.push(item.turn.agentRunId);
    },
    checkRoomAgentSupervisorTurn: () => "READY",
    runCodexAppServerTurn: () => verified,
    prepareRoomAgentBackgroundContinuation: () => ({ state: "DONE" })
  }, async () => {
    const handle = await sandbox.start("roomAgentSupervisorWorkflow", supervisorInput({
      pending: [pending], processedCount: 49, monitoringMissionIds: ["mission:interrupted-monitor"],
      interrupted: [{ item: first, reason: "First stop" }, { item: second, reason: "Second stop" }]
    }), { followRuns: false });
    const carried = await continuedInput(handle);
    expect(carried.input).toEqual(supervisorInput({
      pending: [pending], monitoringMissionIds: ["mission:interrupted-monitor"],
      interrupted: [{ item: second, reason: "Second stop" }], processedCount: 0
    }));
    await eventually(() => finished.length, count => count === 3, "carried interrupted and pending turns");
    expect(finished).toEqual([first.turn.agentRunId, second.turn.agentRunId, pending.turn.agentRunId]);
  });
}, 30_000);
