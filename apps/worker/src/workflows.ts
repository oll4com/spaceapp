import {
  CancellationScope,
  ChildWorkflowCancellationType,
  condition,
  continueAsNew,
  defineSignal,
  executeChild,
  isCancellation,
  proxyActivities,
  setHandler
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
  const input = roomAgentSupervisorInputSchema.parse(rawInput);
  let pending = [...input.pending];
  let interrupted: Array<{ item: RoomAgentSupervisorQueueItem; reason: string }> = [];
  let activeMissionId: string | null = null;
  let activeScope: CancellationScope | null = null;
  let activeStopReason = "Stopped by operator.";
  let processedCount = input.processedCount;

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
    await condition(() => interrupted.length > 0 || pending.length > 0);

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
        if (completion.status === "COMPLETED" && roomAgentMissionHasContinuation(pending, item.missionId)) {
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
        processedCount: 0
      });
    }
  }
}
