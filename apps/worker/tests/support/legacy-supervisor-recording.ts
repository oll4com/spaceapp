/**
 * TEST-ONLY workflow used by npm run temporal:record-histories (and the
 * pre-patch sandbox test) to exercise the supervisor branch that predates
 * the room-background-continuation-v1 patch.
 *
 * New executions of the production roomAgentSupervisorWorkflow always write
 * the patch marker and take the continuing branch, so the only way to
 * produce a marker-less (pre-patch) execution is to run the legacy branch
 * directly. The body below is a verbatim copy of
 * legacyRoomAgentSupervisorWorkflow from src/workflows.ts (kept unchanged
 * upstream "for histories that predate this patch"), so histories recorded
 * here replay against the real workflow code exactly like an execution
 * that was started before the patch shipped.
 *
 * The codexAppServerTurnWorkflow child is replaced by a minimal stub with
 * the same workflow type name; the child has its own history and only the
 * supervisor's own history is recorded and replayed.
 */
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

export const enqueueRoomAgentMissionSignal = defineSignal<[RoomAgentSupervisorQueueItem]>(ROOM_AGENT_ENQUEUE_SIGNAL);
export const stopRoomAgentMissionSignal = defineSignal<[
  { missionId: string | null; reason: string }
]>(ROOM_AGENT_STOP_SIGNAL);

/** Test-only child stand-in; only its workflow type name matters here. */
export async function codexAppServerTurnWorkflow(input: {
  roomId: string; paneId: string; traceId: string;
}): Promise<TurnWorkflowResult> {
  return {
    workflowId: buildCodexAppServerTurnWorkflowId(input),
    roomId: input.roomId,
    paneId: input.paneId,
    traceId: input.traceId,
    status: "COMPLETED",
    message: "Test-only turn",
    roomAgentOutcome: { status: "VERIFIED", executedActionCount: 1, statusReason: "Test-only turn." }
  };
}

const roomAgentTurnActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: ROOM_AGENT_TURN_ACTIVITY_TIMEOUT,
  heartbeatTimeout: ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  retry: {
    maximumAttempts: ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS
  }
});

const { markRoomAgentMissionStarted, markRoomAgentMissionFinished, markRoomAgentMissionContinued } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute",
  retry: {
    maximumAttempts: 5
  }
});

export async function roomAgentSupervisorWorkflow(rawInput: RoomAgentSupervisorInput): Promise<never> {
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
