/**
 * Test-only pre-patch entry point, copied from legacyRoomAgentSupervisorWorkflow
 * in src/workflows.ts at 8a3e1f00f1dc52a2ca0dff160e8520d6c2b2ab2e.
 *
 * It executes the production legacy body literally, without calling patched(),
 * so its recorded history has no room-background-continuation-v1 marker. Replay
 * must use the CURRENT production entry point, which selects the legacy branch
 * from that history. This fixture does not mock the Temporal workflow API.
 * Keep the preserved legacy body aligned with its source; never edit a history
 * or this fixture merely to make a failing replay pass.
 */
import {
  CancellationScope, ChildWorkflowCancellationType, condition, continueAsNew,
  defineSignal, executeChild, isCancellation, proxyActivities, setHandler
} from "@temporalio/workflow";
import {
  buildCodexAppServerTurnWorkflowId, ROOM_AGENT_ENQUEUE_SIGNAL, ROOM_AGENT_STOP_SIGNAL,
  roomAgentSupervisorInputSchema, roomAgentSupervisorQueueItemSchema,
  roomAgentSupervisorStopSignalSchema, type RoomAgentSupervisorInput,
  type RoomAgentSupervisorQueueItem
} from "@space/contracts";
import type * as activities from "../../src/activities.js";
import {
  ROOM_AGENT_TURN_ACTIVITY_TIMEOUT, ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS,
  ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT, enqueueRoomAgentMission,
  roomAgentMissionHasContinuation, roomAgentMissionCompletion, stopRoomAgentMissions
} from "../../src/room-supervisor-state.js";
import { codexAppServerTurnWorkflow } from "../../src/workflows.js";
export {
  codexAppServerTurnWorkflow, dummyTurnWorkflow, dotGoalWorkflow, roomAgentActionWorkflow
} from "../../src/workflows.js";

const roomAgentTurnActivities = proxyActivities<typeof activities>({
  startToCloseTimeout: ROOM_AGENT_TURN_ACTIVITY_TIMEOUT,
  heartbeatTimeout: ROOM_AGENT_TURN_HEARTBEAT_TIMEOUT,
  retry: { maximumAttempts: ROOM_AGENT_TURN_ACTIVITY_MAX_ATTEMPTS }
});
const { markRoomAgentMissionStarted, markRoomAgentMissionFinished, markRoomAgentMissionContinued } = proxyActivities<typeof activities>({
  startToCloseTimeout: "1 minute", retry: { maximumAttempts: 5 }
});
const enqueueRoomAgentMissionSignal = defineSignal<[RoomAgentSupervisorQueueItem]>(ROOM_AGENT_ENQUEUE_SIGNAL);
const stopRoomAgentMissionSignal = defineSignal<[{ missionId: string | null; reason: string }]>(ROOM_AGENT_STOP_SIGNAL);

/**
 * Executes the preserved production supervisor body without the newer patch
 * marker, producing historical input for replay against the current workflow.
 * Its queue, signals, activities and continuation behavior remain unchanged.
 */
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

