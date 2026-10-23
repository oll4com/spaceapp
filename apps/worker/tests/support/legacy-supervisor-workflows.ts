// Frozen pre-patch supervisor snapshot from adb96ac77531649bd335078aacaa0318ce1d20a2.
// The dispatch selects the existing legacy implementation without a patch marker.
// It records genuine unmarked SDK histories; replay always uses CURRENT production code.
// No Temporal API is mocked. Do not refresh this fixture to hide a replay failure.
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
  uuid4,
  workflowInfo
} from "@temporalio/workflow";
import {
  buildCodexAppServerTurnWorkflowId,
  DOT_GOAL_SIGNAL,
  ROOM_AGENT_ENQUEUE_SIGNAL,
  ROOM_AGENT_STOP_SIGNAL,
  isSafeErrorCode,
  roomAgentSupervisorInputSchema,
  roomAgentSupervisorQueueItemSchema,
  roomAgentSupervisorStopSignalSchema,
  type DummyTurnInput,
  type DummyTurnResult,
  type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem,
  type TurnWorkflowResult
} from "@space/contracts";
import type * as activities from "../../src/activities.js";
import {
  ROOM_AGENT_TURN_ACTIVITY_TIMEOUT,
  ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS,
  ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  enqueueRoomAgentMission,
  roomAgentMissionHasContinuation,
  roomAgentMissionCompletion,
  stopRoomAgentMissions
} from "../../src/room-supervisor-state.js";
import { isCliChatTurnProviderId, isNativeChatTurn, NATIVE_CHAT_TURN_ACTIVITY_TIMEOUT } from "../../src/turn-runtime-policy.js";
import { runDotGoalLoop } from "../../src/dot-goal-loop.js";

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

const dotGoalActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: "2 minutes",
  retry: { maximumAttempts: 20, initialInterval: "5 seconds", backoffCoefficient: 2, maximumInterval: "2 minutes" }
});
export const dotGoalWakeSignal = defineSignal<[]>(DOT_GOAL_SIGNAL);

/**
 * Space Dots Goal: start one Chat step at a time and wait for it, until the
 * API reports the Goal finished. State lives in PostgreSQL; this workflow only
 * sequences steps, so it survives worker restarts and closed browsers.
 */
export async function dotGoalWorkflow(input: { goalId: string }): Promise<{ goalStatus: string }> {
  let woken = false;
  setHandler(dotGoalWakeSignal, () => { woken = true; });
  const result = await runDotGoalLoop(input.goalId, {
    step: (goalId) => dotGoalActivities.dotGoalStep(goalId),
    observe: (goalId, runId) => dotGoalActivities.dotGoalObserve(goalId, runId),
    // A wake-up that arrives during an activity is kept and ends the next wait at once.
    wait: async (timeout) => { await condition(() => woken, timeout); woken = false; },
    shouldContinueAsNew: () => workflowInfo().continueAsNewSuggested || workflowInfo().historyLength > 10_000
  }, 300);
  // A long Goal continues as a new run to bound workflow history.
  if (result.goalStatus === null) await continueAsNew<typeof dotGoalWorkflow>({ goalId: input.goalId });
  return { goalStatus: result.goalStatus ?? "UNKNOWN" };
}

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
  return legacyRoomAgentSupervisorWorkflow(rawInput);
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
            statusReason: isCancellation(error) ? activeStopReason : "Room agent child workflow failed.",
            ...(isCancellation(error) ? {} : { errorCode: supervisorFailureCode(error) })
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

function supervisorFailureCode(error: unknown): string {
  let code = "ROOM_AGENT_SUPERVISOR_FAILED";
  let failure = error as { name?: unknown; type?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; failure && depth < 8; depth++, failure = failure.cause as typeof failure) {
    if (failure.name === "TimeoutFailure") code = "ROOM_AGENT_SUPERVISOR_TIMEOUT";
    else if (isSafeErrorCode(failure.type)) code = failure.type;
  }
  return code;
}
