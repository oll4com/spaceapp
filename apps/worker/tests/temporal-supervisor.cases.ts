import { randomUUID } from "node:crypto";
import { Context } from "@temporalio/activity";
import { WorkflowContinuedAsNewError, type Client } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { describe, expect, it, vi } from "vitest";
import {
  ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL, buildCodexAppServerTurnWorkflowId,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema,
  type DummyTurnInput, type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import {
  discardSupervisorTurn, finishSupervisorTurn, prepareBackgroundContinuation, supervisorTurnState,
  type BackgroundContinuationResult
} from "../src/room-background-continuation.js";
import { continuationFixture } from "./room-continuation-fixture.js";
import { withTemporalWorker, recordWorkflowHistory, firstRunHistory } from "./support/temporal-sandbox.js";

// Activities are the ONLY substituted boundary. Signals, child execution,
// cancellation, timers, patch selection and continue-as-new use Temporal itself.
const timeout = 60_000;

/** Creates a host-side barrier that tests release after a real activity or signal reaches the required state. */
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Builds a schema-validated synthetic queue item with distinct mission, run and trace identities. */
function item(roomId: string, suffix: string): RoomAgentSupervisorQueueItem {
  return roomAgentSupervisorQueueItemSchema.parse({ missionId: `mission:${suffix}`, turn: {
    roomId, paneId: "pane:synthetic", prompt: `Synthetic operator request ${suffix}`,
    artifactIds: [], agentRunId: `agent_run:${suffix}`, traceId: `trace:${suffix}`,
    roomAgentMissionId: `mission:${suffix}`
  } });
}

/** Returns a completed, verified activity result that preserves the supplied turn's workflow and room identities. */
function verified(message = "Synthetic room evidence verified.", turn?: DummyTurnInput) {
  return { workflowId: turn ? buildCodexAppServerTurnWorkflowId(turn) : "workflow:synthetic-turn",
    roomId: turn?.roomId ?? "room:synthetic", paneId: turn?.paneId ?? "pane:synthetic",
    traceId: turn?.traceId ?? "trace:synthetic", status: "COMPLETED" as const, message, roomAgentOutcome: {
    status: "VERIFIED" as const, executedActionCount: 1, statusReason: message
  } };
}

/** Polls a host or history observation with a bounded wait while the genuine Temporal worker progresses. */
async function eventually(predicate: () => unknown | Promise<unknown>) {
  await expect.poll(predicate, { timeout: 20_000, interval: 20 }).toBeTruthy();
}

/** Terminates the workflow's current execution chain during cleanup, tolerating an already closed execution. */
async function stop(handle: any) {
  // A start handle targets the execution chain, including a continued run.
  await handle.terminate("Synthetic Temporal test cleanup.").catch(() => undefined);
}

/** Requires the first run to continue as new, then decodes and validates its carried supervisor state. */
async function firstContinue(client: Client, handle: any) {
  // Handle.result follows the execution chain by default. Set followRuns on
  // the client's pinned first-run request, not as an ignored handle argument.
  await expect(client.workflow.result(handle.workflowId, handle.firstExecutionRunId, { followRuns: false }))
    .rejects.toBeInstanceOf(WorkflowContinuedAsNewError);
  const history = await firstRunHistory(handle, client);
  const event = history.events?.find((entry: any) => entry.workflowExecutionContinuedAsNewEventAttributes);
  const attrs = event?.workflowExecutionContinuedAsNewEventAttributes;
  expect(attrs?.input?.payloads).toHaveLength(1);
  const carried = roomAgentSupervisorInputSchema.parse(defaultPayloadConverter.fromPayload(attrs!.input!.payloads![0]!));
  return { history, carried, nextRunId: attrs!.newExecutionRunId! };
}

/** Selects scheduled activity events of one type so assertions remain scoped to the inspected workflow run. */
function activityEvents(history: any, activityType: string) {
  return (history.events ?? []).filter((event: any) =>
    event.activityTaskScheduledEventAttributes?.activityType?.name === activityType);
}

/** Selects actual timer-start events for checking polling duration and continue-as-new boundaries. */
function timers(history: any) {
  return (history.events ?? []).filter((event: any) => event.timerStartedEventAttributes);
}

/** Sends a real signal and waits for a completed workflow task after its persisted history event. */
async function signalHandled(handle: any, name: string, value: unknown) {
  await handle.signal(name, value);
  // Signal acknowledgement means persisted, not necessarily processed. Keep an
  // in-flight activity held until a workflow task actually handled the signal.
  await eventually(async () => {
    const events = (await firstRunHistory(handle)).events ?? [];
    const signal = [...events].reverse().find((event: any) =>
      event.workflowExecutionSignaledEventAttributes?.signalName === name);
    return signal && events.some((event: any) => event.workflowTaskCompletedEventAttributes &&
      Number(event.eventId) > Number(signal.eventId));
  });
}

/** A cancellable activity, including the heartbeat needed to receive a stop. */
async function waitForCancellation() {
  const context = Context.current();
  const heartbeat = setInterval(() => context.heartbeat("synthetic waiting turn"), 25);
  try { return await context.cancelled; }
  finally { clearInterval(heartbeat); }
}

/** Supplies activity-boundary spies for both supervisor contracts while leaving workflow execution real. */
function simpleActivities() {
  return {
    checkRoomAgentSupervisorTurn: vi.fn(async (_input: any): Promise<"READY" | "PAUSED" | "SKIP"> => "READY"),
    prepareRoomAgentBackgroundContinuation: vi.fn(async (_input: any): Promise<BackgroundContinuationResult> => ({ state: "DONE" })),
    discardRoomAgentSupervisorTurn: vi.fn(async (_input: any) => undefined),
    finishRoomAgentSupervisorTurn: vi.fn(async (_input: any) => undefined),
    runCodexAppServerTurn: vi.fn(async (turn: DummyTurnInput) => verified(undefined, turn)),
    markRoomAgentMissionStarted: vi.fn(async (_input: any) => undefined),
    markRoomAgentMissionFinished: vi.fn(async (_input: any) => undefined),
    markRoomAgentMissionContinued: vi.fn(async (_input: any) => undefined),
    settleRoomAgentBackgroundMission: vi.fn(async (_input: any) => true)
  };
}

/** Runs the real continuation activities against the fixture store and substitutes only the external Codex turn. */
function storedActivities(c: ReturnType<typeof continuationFixture>) {
  return {
    prepareRoomAgentBackgroundContinuation: vi.fn((input: Parameters<typeof prepareBackgroundContinuation>[0]) => prepareBackgroundContinuation(input, c.store)),
    checkRoomAgentSupervisorTurn: vi.fn((turn: RoomAgentSupervisorQueueItem) => supervisorTurnState(turn, c.store)),
    discardRoomAgentSupervisorTurn: vi.fn(({ item: turn, reason }: { item: RoomAgentSupervisorQueueItem; reason: string }) => discardSupervisorTurn(turn, reason, c.store)),
    finishRoomAgentSupervisorTurn: vi.fn((input: Parameters<typeof finishSupervisorTurn>[0]) => finishSupervisorTurn(input, c.store)),
    runCodexAppServerTurn: vi.fn(async (turn: DummyTurnInput) => {
      if (!turn.agentRunId) throw new Error("The synthetic supervisor turn must identify its persisted agent run.");
      c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
      return verified(undefined, turn);
    })
  };
}

/** Registers sequential real-server cases for supervisor signals, cancellation, legacy behavior and carried state. */
export function registerSupervisorCases(): void {
  describe.sequential("Room Agent supervisor in the real Temporal sandbox", () => {
    for (const legacy of [false, true]) {
      const branch = legacy ? "pre-patch" : "current";
      describe.sequential(branch, () => {
        it("handles enqueue, pending duplicates and stop signals, and cancels an executing child", async () => {
          const activities = simpleActivities();
          const childStarted = deferred<void>();
          let cancelled = false;
          const turns: string[] = [];
          activities.runCodexAppServerTurn.mockImplementation(async (turn: any) => {
            turns.push(turn.traceId);
            if (turn.traceId === "trace:active") {
              childStarted.resolve();
              try { await waitForCancellation(); }
              finally { cancelled = true; }
            }
            return verified(undefined, turn);
          });
          await withTemporalWorker(activities, async ({ client, taskQueue }) => {
            const roomId = `room:${randomUUID()}`;
            const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
              workflowId: `supervisor:${randomUUID()}`, taskQueue,
              args: [roomAgentSupervisorInputSchema.parse({ roomId })]
            });
            try {
              await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(roomId, "active"));
              await childStarted.promise;
              // These arrive while the first child is running. Only one valid
              // queued item survives; invalid and foreign-room items are ignored.
              await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, { missionId: "bad", turn: {} });
              await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item("room:foreign", "foreign"));
              await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(roomId, "queued"));
              await signalHandled(handle, ROOM_AGENT_ENQUEUE_SIGNAL, item(roomId, "queued"));
              await signalHandled(handle, ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stopped by a real signal." });
              const finished = legacy ? activities.markRoomAgentMissionFinished : activities.finishRoomAgentSupervisorTurn;
              await eventually(() => cancelled && finished.mock.calls.length === 2);
              const terminal = finished.mock.calls.map(([input]: any[]) => ({
                missionId: input.missionId ?? input.item.missionId,
                status: input.status, reason: input.statusReason
              }));
              expect(terminal).toEqual([
                { missionId: "mission:active", status: "INTERRUPTED", reason: "Stopped by a real signal." },
                { missionId: "mission:queued", status: "INTERRUPTED", reason: "Stopped by a real signal." }
              ]);
              expect(turns).toEqual(["trace:active"]);
              await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(roomId, "after-stop"));
              await eventually(() => finished.mock.calls.length === 3);
              expect(turns).toEqual(["trace:active", "trace:after-stop"]);
              expect(finished.mock.calls[2]![0]).toMatchObject({ status: "COMPLETED" });
            } finally { await stop(handle); }
          }, { legacy });
        }, timeout);

        it("uses a real one-second polling condition and the branch-specific activity contract", async () => {
          const activities = simpleActivities();
          await withTemporalWorker(activities, async ({ env, client, taskQueue }) => {
            const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
              workflowId: `supervisor:${randomUUID()}`, taskQueue,
              args: [roomAgentSupervisorInputSchema.parse({ roomId: "room:poll", monitoringMissionIds: ["mission:poll"] })]
            });
            try {
              await eventually(async () => timers(await firstRunHistory(handle)).length === 1);
              const timer = timers(await firstRunHistory(handle))[0].timerStartedEventAttributes;
              expect(Number(timer.startToFireTimeout.seconds)).toBe(1);
              await env.sleep("1 second");
              const poll = legacy ? activities.settleRoomAgentBackgroundMission : activities.prepareRoomAgentBackgroundContinuation;
              await eventually(() => poll.mock.calls.length === 1);
              expect(poll.mock.calls[0]![0]).toMatchObject({ roomId: "room:poll", missionId: "mission:poll" });
              if (legacy) expect(activities.prepareRoomAgentBackgroundContinuation).not.toHaveBeenCalled();
              else {
                expect(activities.settleRoomAgentBackgroundMission).not.toHaveBeenCalled();
                expect(activities.prepareRoomAgentBackgroundContinuation.mock.calls[0]![0]).toHaveProperty("continuationId");
              }
              expect(activities.runCodexAppServerTurn).not.toHaveBeenCalled();
            } finally { await stop(handle); }
          }, { legacy });
        }, timeout);

        it("continues after the fiftieth processed item with its pending and monitoring state intact", async () => {
          const activities = simpleActivities();
          await withTemporalWorker(activities, async ({ client, taskQueue }) => {
            const roomId = `room:${randomUUID()}`;
            const queued = [item(roomId, "fiftieth"), item(roomId, "next-run")];
            const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
              workflowId: `supervisor:${randomUUID()}`, taskQueue,
              args: [roomAgentSupervisorInputSchema.parse({ roomId, pending: queued,
                monitoringMissionIds: ["mission:background"], processedCount: 49 })]
            });
            try {
              const { carried, history } = await firstContinue(client, handle);
              expect(carried).toEqual(roomAgentSupervisorInputSchema.parse({ roomId,
                pending: [queued[1]], monitoringMissionIds: ["mission:background"], interrupted: [], processedCount: 0 }));
              // Restrict this assertion to the first run: Temporal can already
              // execute the carried item in the new run before the client reads.
              expect((history.events ?? []).filter((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toHaveLength(1);
              const firstRunFinished = activityEvents(history, legacy ? "markRoomAgentMissionFinished" : "finishRoomAgentSupervisorTurn");
              expect(firstRunFinished).toHaveLength(1);
              await recordWorkflowHistory(legacy ? "roomAgentSupervisorWorkflow.pre-patch" : "roomAgentSupervisorWorkflow", handle, { firstRun: true });
            } finally { await stop(handle); }
          }, { legacy });
        }, timeout);

        it("continues after 250 one-second polls without losing the monitoring set", async () => {
          const activities = simpleActivities();
          activities.prepareRoomAgentBackgroundContinuation.mockResolvedValue({ state: "WAITING" });
          activities.settleRoomAgentBackgroundMission.mockResolvedValue(false);
          await withTemporalWorker(activities, async ({ client, taskQueue }) => {
            const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
              workflowId: `supervisor:${randomUUID()}`, taskQueue,
              args: [roomAgentSupervisorInputSchema.parse({ roomId: "room:250-polls",
                monitoringMissionIds: ["mission:still-running"], processedCount: 7 })]
            });
            let waiting: ReturnType<typeof firstContinue> | undefined;
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              // A fresh genuine server isolates this long polling run from any
              // previous case's clock locks. Use automatic time skipping only.
              await eventually(async () => timers(await firstRunHistory(handle, client)).length > 0);
              waiting = firstContinue(client, handle);
              const { carried, history } = await Promise.race([waiting, new Promise<never>((_, reject) => {
                deadline = setTimeout(() => {
                  const poll = legacy ? activities.settleRoomAgentBackgroundMission : activities.prepareRoomAgentBackgroundContinuation;
                  reject(new Error(`The isolated supervisor did not continue within 30 seconds; ${poll.mock.calls.length} poll activities executed.`));
                }, 30_000);
              })]);
              expect(carried).toEqual(roomAgentSupervisorInputSchema.parse({ roomId: "room:250-polls",
                pending: [], interrupted: [], monitoringMissionIds: ["mission:still-running"],
                // This is the actual legacy contract, not a changed workflow.
                processedCount: legacy ? 7 : 0 }));
              expect(timers(history)).toHaveLength(250);
              expect(timers(history).every((event: any) =>
                Number(event.timerStartedEventAttributes.startToFireTimeout.seconds) === 1)).toBe(true);
              expect(activityEvents(history, legacy ? "settleRoomAgentBackgroundMission" : "prepareRoomAgentBackgroundContinuation")).toHaveLength(250);
            } finally {
              clearTimeout(deadline);
              await stop(handle);
              // Release result()'s time-skipping scope before isolated teardown,
              // including when the bounded diagnostic guard terminates the run.
              await waiting?.catch(() => undefined);
            }
          }, { legacy, isolated: true });
        }, timeout);
      });
    }

    it("preserves an unprocessed interruption and its reason across continue-as-new", async () => {
      const activities = simpleActivities();
      await withTemporalWorker(activities, async ({ client, taskQueue }) => {
        const roomId = `room:${randomUUID()}`;
        const pending = [item(roomId, "pending-after-interruptions")];
        const interrupted = [
          { item: item(roomId, "first-interruption"), reason: "First synthetic stop." },
          { item: item(roomId, "carried-interruption"), reason: "Keep this stop reason in the next run." }
        ];
        const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor:${randomUUID()}`, taskQueue,
          args: [roomAgentSupervisorInputSchema.parse({ roomId, pending, interrupted,
            monitoringMissionIds: ["mission:unrelated-background"], processedCount: 49 })]
        });
        try {
          const { carried, history } = await firstContinue(client, handle);
          expect(carried).toEqual(roomAgentSupervisorInputSchema.parse({ roomId, pending,
            interrupted: [interrupted[1]], monitoringMissionIds: ["mission:unrelated-background"], processedCount: 0 }));
          expect(activityEvents(history, "discardRoomAgentSupervisorTurn")).toHaveLength(1);
          expect(activityEvents(history, "finishRoomAgentSupervisorTurn")).toHaveLength(1);
          expect((history.events ?? []).some((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
        } finally { await stop(handle); }
      });
    }, timeout);

    it("retains paused work across a real one-second timeout and then processes it exactly once", async () => {
      const activities = simpleActivities();
      activities.checkRoomAgentSupervisorTurn.mockResolvedValueOnce("PAUSED");
      await withTemporalWorker(activities, async ({ env, client, taskQueue }) => {
        const roomId = `room:${randomUUID()}`;
        const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor:${randomUUID()}`, taskQueue,
          args: [roomAgentSupervisorInputSchema.parse({ roomId, pending: [item(roomId, "paused")] })]
        });
        try {
          await eventually(async () => timers(await firstRunHistory(handle)).length === 1);
          expect(activities.runCodexAppServerTurn).not.toHaveBeenCalled();
          await env.sleep("1 second");
          await eventually(() => activities.finishRoomAgentSupervisorTurn.mock.calls.length === 1);
          expect(activities.checkRoomAgentSupervisorTurn).toHaveBeenCalledTimes(2);
          expect(activities.runCodexAppServerTurn.mock.calls.map(([turn]) => turn.traceId))
            .toEqual(["trace:paused"]);
          const history = await firstRunHistory(handle);
          expect((history.events ?? []).filter((event: any) => event.timerFiredEventAttributes)).toHaveLength(1);
          expect(timers(history)).toHaveLength(1);
        } finally { await stop(handle); }
      });
    }, timeout);

    it("runs allocation -> send -> verification once in one mission, using the real continuation activities", async () => {
      const c = continuationFixture();
      const activities = storedActivities(c);
      activities.runCodexAppServerTurn.mockImplementationOnce(async (turn) => {
        if (!turn.agentRunId) throw new Error("The synthetic allocation turn must identify its persisted agent run.");
        expect(turn.prompt).toContain("Open CLI and Chat, then send a story");
        c.store.createRoomAgentAction({ ...c.action, actionId: "action:send", idempotencyKey: "send-once", actionType: "SEND",
          evidence: { cli: "Story complete", chat: "Story complete" }, statusReason: "Both tasks completed." });
        c.store.updateSpaceAgentRun(turn.agentRunId, { status: "COMPLETED" });
        return { ...verified("Sent", turn), roomAgentOutcome: { ...verified("Sent", turn).roomAgentOutcome, pendingActionIds: ["action:send"] } };
      });
      await withTemporalWorker(activities, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor:${randomUUID()}`, taskQueue,
          args: [roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] })]
        });
        const running = handle.result().catch(() => undefined);
        try {
          // result() unlocks time skipping while a store-state barrier waits for
          // completion. The supervisor remains long-lived, so terminate it once
          // the second child has supplied verified completion.
          await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
          expect(activities.runCodexAppServerTurn).toHaveBeenCalledTimes(2);
          expect(c.store.listRoomAgentActions(c.initial.mission.id).filter((action) => action.actionType === "SEND")).toHaveLength(1);
          expect(activities.finishRoomAgentSupervisorTurn).toHaveBeenCalledOnce();
        } finally { await stop(handle); await running; }
      });
    }, timeout);

    it.each(["stop", "follow-up"] as const)("retires the prepared run when %s is handled before its activity reply", async (kind) => {
      const c = continuationFixture();
      const activities = storedActivities(c);
      const prepared = deferred<RoomAgentSupervisorQueueItem>();
      const release = deferred<void>();
      activities.prepareRoomAgentBackgroundContinuation.mockImplementationOnce(async (input) => {
        const result = await prepareBackgroundContinuation(input, c.store);
        if (result.state !== "READY") throw new Error("Synthetic continuation was not prepared.");
        prepared.resolve(result.item);
        await release.promise;
        return result;
      });
      await withTemporalWorker(activities, async ({ env, client, taskQueue }) => {
        const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor:${randomUUID()}`, taskQueue,
          args: [roomAgentSupervisorInputSchema.parse({ roomId: c.room.id, monitoringMissionIds: [c.initial.mission.id] })]
        });
        try {
          await eventually(async () => timers(await firstRunHistory(handle)).length === 1);
          await env.sleep("1 second");
          const stale = await prepared.promise;
          if (kind === "stop") {
            c.store.updateRoomAgentMission(c.initial.mission.id, { status: "INTERRUPTED" });
            await signalHandled(handle, ROOM_AGENT_STOP_SIGNAL, { missionId: null, reason: "Stop" });
          } else {
            const followUp = c.enqueue("follow-up", "Only inspect the room.");
            await signalHandled(handle, ROOM_AGENT_ENQUEUE_SIGNAL, followUp.queueItem);
          }
          release.resolve();
          await eventually(() => c.store.getRoomAgentTurn(c.initial.mission.id, stale.turn.agentRunId)?.run.status === "INTERRUPTED");
          expect(activities.discardRoomAgentSupervisorTurn).toHaveBeenCalledWith({
            item: stale, reason: "Superseded while preparing the automatic continuation."
          });
          if (kind === "stop") expect(activities.runCodexAppServerTurn).not.toHaveBeenCalled();
          else {
            await eventually(() => activities.runCodexAppServerTurn.mock.calls.length > 0);
            expect(activities.runCodexAppServerTurn.mock.calls[0]![0].roomAgentOperatorRequest).toBe("Only inspect the room.");
          }
        } finally { release.resolve(); await stop(handle); }
      });
    }, timeout);

    it("carries a prepared continuation through continue-as-new, then starts it exactly once", async () => {
      const c = continuationFixture();
      const activities = storedActivities(c);
      const release = deferred<void>();
      activities.checkRoomAgentSupervisorTurn.mockImplementation(async (turn) => {
        await release.promise;
        return supervisorTurnState(turn, c.store);
      });
      await withTemporalWorker(activities, async ({ client, taskQueue }) => {
        const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor:${randomUUID()}`, taskQueue,
          args: [roomAgentSupervisorInputSchema.parse({ roomId: c.room.id,
            monitoringMissionIds: [c.initial.mission.id], processedCount: 50 })]
        });
        try {
          const { carried, history } = await firstContinue(client, handle);
          expect(carried.pending).toHaveLength(1);
          expect((history.events ?? []).some((event: any) => event.startChildWorkflowExecutionInitiatedEventAttributes)).toBe(false);
          expect(activities.runCodexAppServerTurn).not.toHaveBeenCalled();
          release.resolve();
          await eventually(() => c.store.getRoomAgentMission(c.room.id, c.initial.mission.id)?.status === "COMPLETED");
          expect(activities.runCodexAppServerTurn).toHaveBeenCalledOnce();
          expect(activities.runCodexAppServerTurn.mock.calls[0]![0].agentRunId).toBe(carried.pending[0]!.turn.agentRunId);
        } finally { release.resolve(); await stop(handle); }
      });
    }, timeout);

    it("drains an oversized signaled queue until the next run's schema accepts the carried state", async () => {
      const activities = simpleActivities();
      const started = deferred<any>();
      const firstRunChecks: RoomAgentSupervisorQueueItem[] = [];
      activities.checkRoomAgentSupervisorTurn.mockImplementation(async (turn: any) => {
        const handle = await started.promise;
        const execution = Context.current().info.workflowExecution;
        if (!execution) throw new Error("The synthetic supervisor check must run inside a workflow execution.");
        if (execution.runId !== handle.firstExecutionRunId) {
          await waitForCancellation();
          return "SKIP";
        }
        firstRunChecks.push(turn);
        if (firstRunChecks.length === 1) {
          for (let index = 1; index <= 105; index++) {
            await handle.signal(ROOM_AGENT_ENQUEUE_SIGNAL, item(turn.turn.roomId, `flood-${index}`));
          }
          await eventually(async () => {
            const events = (await firstRunHistory(handle)).events ?? [];
            const signals = events.filter((event: any) => event.workflowExecutionSignaledEventAttributes);
            const last = signals[signals.length - 1];
            return signals.length === 105 && last !== undefined && events.some((event: any) =>
              event.workflowTaskCompletedEventAttributes && Number(event.eventId) > Number(last.eventId));
          });
        }
        return "SKIP";
      });
      await withTemporalWorker(activities, async ({ client, taskQueue }) => {
        const roomId = `room:${randomUUID()}`;
        const handle = await client.workflow.start("roomAgentSupervisorWorkflow", {
          workflowId: `supervisor:${randomUUID()}`, taskQueue,
          args: [roomAgentSupervisorInputSchema.parse({ roomId, pending: [item(roomId, "flood-0")], processedCount: 49 })]
        });
        started.resolve(handle);
        try {
          const { carried, history } = await firstContinue(client, handle);
          expect(carried.pending).toHaveLength(100);
          expect(() => roomAgentSupervisorInputSchema.parse(JSON.parse(JSON.stringify(carried)))).not.toThrow();
          expect(firstRunChecks).toHaveLength(6);
          expect(activityEvents(history, "checkRoomAgentSupervisorTurn")).toHaveLength(6);
          expect(activityEvents(history, "discardRoomAgentSupervisorTurn")).toHaveLength(6);
          expect(new Set([...firstRunChecks, ...carried.pending].map((turn) => turn.turn.agentRunId)).size).toBe(106);
          expect(activities.runCodexAppServerTurn).not.toHaveBeenCalled();
        } finally { await stop(handle); }
      });
    }, timeout);
  });
}
