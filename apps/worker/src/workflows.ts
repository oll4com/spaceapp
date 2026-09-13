import {
  CancellationScope,
  ChildWorkflowCancellationType,
  condition,
  continueAsNew,
  defineSignal,
  executeChild,
  isCancellation,
  patched,
  proxyActivities,
  setHandler,
  uuid4
} from "@temporalio/workflow";
import {
  buildCodexAppServerTurnWorkflowId,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  roomAgentSupervisorStopSignalSchema,
  type DummyTurnInput,
  type DummyTurnResult,
  type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem,
  type TurnWorkflowResult
} from "@space/contracts";
import type * as activities from "./activities.js";
import {
  ROOM_AGENT_TURN_ACTIVITY_TIMEOUT,
  ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS,
  ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  enqueueRoomAgentMission,
  roomAgentMissionHasContinuation,
  roomAgentMissionCompletion,
  stopRoomAgentMissions
} from "./room-supervisor-state.js";
import { isCliChatTurnProviderId, isNativeChatTurn, NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT } from "./turn-runtime-policy.js";

const { recordDummyTurnStarted, recordDummyTurnCompleted } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 3
  }
});

const roomAgentTurnActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: ROOM_AGENT_TURN_ACTIVITY_TIMEOUT,
  heartbeatTimeout: ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS
  }
});

const nativeChatTurnActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT,
  heartbeatTimeout: ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS
  }
});

const openCodeAgentTurnActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "40 minutes",
  heartbeatTimeout: ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: 1
  }
});

const cliChatTurnActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 minutes",
  heartbeatTimeout: ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: 1
  }
});

const { markRoomAgentMissionStarted, markRoomAgentMissionFinished, markRoomAgentMissionContinued } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 5
  }
});

export const enqueueRoomAgentMissionSignal = defineSignal<[RoomAgentSupervisorQueueItem]>(ROOM_AGENT_ENQUEUE_SIGNAL);
export const stopRoomAgentMissionSignal = defineSignal<[
  { missionId: string | null; reason: string }
]>(ROOM_AGENT_STOP_SIGNAL);

export async function dummyTurnWorkflow(input: DummyTurnInput): Promise<DummyTurnResult> {
  await recordDummyTurnStarted(input);
  return recordDummyTurnCompleted(input);
}

export async function codexAppServerTurnWorkflow(input: DummyTurnInput): Promise<TurnWorkflowResult> {
  if (input.providerId === "opencode") {
    return openCodeAgentTurnActivities.runOpenCodeAgentTurn(input);
  }
  if (isCliChatTurnProviderId(input.providerId)) {
    return cliChatTurnActivities.runCliAgentTurn(input);
  }
  return isNativeChatTurn(input)
    ? nativeChatTurnActivities.runCodexAppServerTurn(input)
    : roomAgentTurnActivities.runCodexAppServerTurn(input);
}

export async function roomAgentSupervisorWorkflow(rawInput: RoomAgentSupervisorInput): Promise<never> {
  // Keep the old activity/boolean contract for histories that predate this patch.
  if (!patched("room-background-continuation-v1")) return legacyRoomAgentSupervisorWorkflow(rawInput);
  return continuingRoomAgentSupervisorWorkflow(rawInput);
}

async function legacyRoomAgentSupervisorWorkflow(rawInput: RoomAgentSupervisorInput): Promise<never> {
  const input = roomAgentSupervisorInputSchema.parse(rawInput);
  let pending = [...input.pending];
  let interrupted: Array<{ item: RoomAgentSupervisorQueueItem; reason: string }> = [];
  let activeMissionId: string | null = null;
  let activeScope: CancellationScope | null = null;
  let activeStopReason = "Stopped by operator.";
  let processedCount = input.processedCount;
  const monitoring = new Set(input.monitoringMissionIds);
  let monitoringPolls = 0;

  setHandler(enqueueRoomAgentMissionSignal, (rawItem) => {
    const parsed = roomAgentSupervisorQueueItemSchema.safeParse(rawItem);
    if (!parsed.success || parsed.data.turn.roomId !== input.roomId) return;
    pending = enqueueRoomAgentMission(pending, activeMissionId, parsed.data);
  });

  setHandler(stopRoomAgentMissionSignal, (rawSignal) => {
    const parsed = roomAgentSupervisorStopSignalSchema.safeParse(rawSignal);
    if (!parsed.success) return;
    const stopped = stopRoomAgentMissions(pending, activeMissionId, parsed.data);
    pending = stopped.pending;
    interrupted = [
      ...interrupted,
      ...stopped.interrupted.map((item) => ({ item, reason: parsed.data.reason }))
    ];
    if (stopped.shouldCancelActive) {
      activeStopReason = parsed.data.reason;
      activeScope?.cancel();
    }
  });

  for (;;) {
    if (monitoring.size && !pending.length && !interrupted.length) {
      await condition(() => pending.length > 0 || interrupted.length > 0, "1 second");
      if (!pending.length && !interrupted.length) {
        for (const missionId of monitoring) {
          const finished = await roomAgentTurnActivities.settleRoomAgentBackgroundMission({ roomId: input.roomId, missionId });
          if (finished) monitoring.delete(missionId);
        }
        if (++monitoringPolls >= 250) return continueAsNew<typeof roomAgentSupervisorWorkflow>({ ...input, pending, processedCount, monitoringMissionIds: [...monitoring] });
        continue;
      }
    } else await condition(() => interrupted.length > 0 || pending.length > 0);

    const stoppedBeforeStart = interrupted.shift();
    if (stoppedBeforeStart) {
      await markRoomAgentMissionFinished({
        missionId: stoppedBeforeStart.item.missionId,
        roomId: stoppedBeforeStart.item.turn.roomId,
        status: "INTERRUPTED",
        statusReason: stoppedBeforeStart.reason
      });
      processedCount += 1;
    } else {
      const item = pending.shift()!;
      activeMissionId = item.missionId;
      activeStopReason = "Stopped by operator.";
      activeScope = new CancellationScope({ cancellable: true });
      await markRoomAgentMissionStarted({ missionId: item.missionId, roomId: item.turn.roomId, paneId: item.turn.paneId });
      try {
        const result = await activeScope.run(() =>
          executeChild(codexAppServerTurnWorkflow, {
            args: [item.turn],
            workflowId: buildCodexAppServerTurnWorkflowId(item.turn),
            cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED
          })
        );
        const completion = roomAgentMissionCompletion(result);
        if (result.roomAgentOutcome?.status === "VERIFIED" && result.roomAgentOutcome.pendingActionIds?.length) {
          monitoring.add(item.missionId);
          await markRoomAgentMissionContinued({ missionId: item.missionId, roomId: item.turn.roomId,
            statusReason: "Pane work is running independently. Room Agent is ready for further commands." });
        } else if (monitoring.has(item.missionId) || (completion.status === "COMPLETED" && roomAgentMissionHasContinuation(pending, item.missionId))) {
          await markRoomAgentMissionContinued({
            missionId: item.missionId,
            roomId: item.turn.roomId,
            statusReason: "The current turn completed; continuing the same goal with the next operator follow-up."
          });
        } else {
          await markRoomAgentMissionFinished({
            missionId: item.missionId,
            roomId: item.turn.roomId,
            status: completion.status,
            statusReason: completion.statusReason
          });
        }
      } catch (error) {
        await CancellationScope.nonCancellable(() =>
          markRoomAgentMissionFinished({
            missionId: item.missionId,
            roomId: item.turn.roomId,
            status: isCancellation(error) ? "INTERRUPTED" : "FAILED",
            statusReason: isCancellation(error) ? activeStopReason : "Room agent child workflow failed."
          })
        );
      } finally {
        activeMissionId = null;
        activeScope = null;
        processedCount += 1;
      }
    }

    if (processedCount >= 50) {
      await continueAsNew<typeof roomAgentSupervisorWorkflow>({
        roomId: input.roomId,
        pending,
        monitoringMissionIds: [...monitoring],
        interrupted: [],
        processedCount: 0
      });
    }
  }
}

const supervisorActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute", retry: { maximumAttempts: 5 }
});

async function continuingRoomAgentSupervisorWorkflow(rawInput: RoomAgentSupervisorInput): Promise<never> {
  const input = roomAgentSupervisorInputSchema.parse(rawInput);
  let pending = [...input.pending];
  let interrupted = [...input.interrupted];
  const monitoring = new Set(input.monitoringMissionIds);
  let active: RoomAgentSupervisorQueueItem | null = null;
  let scope: CancellationScope | null = null;
  let stopReason = "Stopped by operator.";
  let signalRevision = 0;
  let processedCount = input.processedCount;
  let polls = 0;

  setHandler(enqueueRoomAgentMissionSignal, (rawItem) => {
    const parsed = roomAgentSupervisorQueueItemSchema.safeParse(rawItem);
    if (!parsed.success || parsed.data.turn.roomId !== input.roomId) return;
    const item = parsed.data;
    if (active?.turn.agentRunId === item.turn.agentRunId || pending.some((p) => p.turn.agentRunId === item.turn.agentRunId)) return;
    signalRevision++;
    // An operator follow-up wins over speculative automatic work.
    if (!item.turn.roomAgentContinuation) {
      const stale = pending.filter((p) => p.missionId === item.missionId && p.turn.roomAgentContinuation);
      interrupted.push(...stale.map((item) => ({ item, reason: "Superseded by a newer operator request." })));
      pending = pending.filter((p) => !stale.includes(p));
      if (active?.missionId === item.missionId && active.turn.roomAgentContinuation) {
        stopReason = "Superseded by a newer operator request.";
        scope?.cancel();
      }
    }
    pending = enqueueRoomAgentMission(pending, active?.missionId ?? null, item);
  });
  setHandler(stopRoomAgentMissionSignal, (rawSignal) => {
    const parsed = roomAgentSupervisorStopSignalSchema.safeParse(rawSignal);
    if (!parsed.success) return;
    signalRevision++;
    const stopped = stopRoomAgentMissions(pending, active?.missionId ?? null, parsed.data);
    pending = stopped.pending;
    interrupted.push(...stopped.interrupted.map((item) => ({ item, reason: parsed.data.reason })));
    for (const missionId of monitoring) if (!parsed.data.missionId || parsed.data.missionId === missionId) monitoring.delete(missionId);
    if (stopped.shouldCancelActive) { stopReason = parsed.data.reason; scope?.cancel(); }
  });

  for (;;) {
    if (interrupted.length) {
      const stopped = interrupted.shift()!;
      await supervisorActivities.discardRoomAgentSupervisorTurn(stopped);
      // A discarded automatic turn must never terminate its newer operator turn.
      await supervisorActivities.finishRoomAgentSupervisorTurn({ item: stopped.item, status: "INTERRUPTED", statusReason: stopped.reason });
      processedCount++;
    } else if (pending.length) {
      const item = pending.shift()!;
      active = item;
      scope = new CancellationScope({ cancellable: true });
      stopReason = "Stopped by operator.";
      let paused = false;
      try {
        await scope.run(async () => {
          const state = await supervisorActivities.checkRoomAgentSupervisorTurn(item);
          if (state === "PAUSED") { paused = true; return; }
          if (state === "SKIP") {
            await supervisorActivities.discardRoomAgentSupervisorTurn({ item, reason: "Turn is no longer active or was superseded." });
            return;
          }
          const result = await executeChild(codexAppServerTurnWorkflow, {
            args: [item.turn], workflowId: buildCodexAppServerTurnWorkflowId(item.turn),
            cancellationType: ChildWorkflowCancellationType.WAIT_CANCELLATION_COMPLETED
          });
          const completion = roomAgentMissionCompletion(result);
          if (result.roomAgentOutcome?.status === "VERIFIED" && result.roomAgentOutcome.pendingActionIds?.length) {
            monitoring.add(item.missionId);
          } else if (completion.status === "COMPLETED" && monitoring.has(item.missionId) && !item.turn.roomAgentContinuation) {
            // A FIND/layout follow-up can finish while earlier pane tasks continue.
          } else if (!roomAgentMissionHasContinuation(pending, item.missionId)) {
            monitoring.delete(item.missionId);
            await supervisorActivities.finishRoomAgentSupervisorTurn({ item, ...completion });
          }
        });
      } catch (error) {
        await CancellationScope.nonCancellable(async () => {
          const reason = isCancellation(error) ? stopReason : "Room Agent supervisor turn failed.";
          await supervisorActivities.discardRoomAgentSupervisorTurn({ item, reason });
          if (!roomAgentMissionHasContinuation(pending, item.missionId)) {
            monitoring.delete(item.missionId);
            await supervisorActivities.finishRoomAgentSupervisorTurn({ item, status: isCancellation(error) ? "INTERRUPTED" : "FAILED", statusReason: reason });
          }
        });
      } finally { active = null; scope = null; processedCount++; }
      if (paused) {
        pending.push(item);
        const revision = signalRevision;
        await condition(() => interrupted.length > 0 || signalRevision !== revision, "1 second");
      }
    } else if (monitoring.size) {
      await condition(() => pending.length > 0 || interrupted.length > 0, "1 second");
      if (!pending.length && !interrupted.length) for (const missionId of monitoring) {
        const revision = signalRevision;
        const result = await supervisorActivities.prepareRoomAgentBackgroundContinuation({
          roomId: input.roomId, missionId, continuationId: uuid4()
        });
        if (result.state === "DONE") monitoring.delete(missionId);
        if (result.state === "READY") {
          if (revision !== signalRevision || !monitoring.has(missionId)) {
            await supervisorActivities.discardRoomAgentSupervisorTurn({ item: result.item, reason: "Superseded while preparing the automatic continuation." });
          } else pending = enqueueRoomAgentMission(pending, null, result.item);
        }
        if (pending.length || interrupted.length) break;
      }
      polls++;
    } else await condition(() => pending.length > 0 || interrupted.length > 0);

    if (processedCount >= 50 || polls >= 250) return continueAsNew<typeof roomAgentSupervisorWorkflow>({
      roomId: input.roomId, pending, interrupted, monitoringMissionIds: [...monitoring], processedCount: 0
    });
  }
}

export async function roomAgentActionWorkflow(input: Parameters<typeof activities.runRoomAgentBackgroundAction>[0]) {
  return roomAgentTurnActivities.runRoomAgentBackgroundAction(input);
}
