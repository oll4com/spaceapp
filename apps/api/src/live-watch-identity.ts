import type { ControlWatch } from "@space/contracts";
import type { RoomPaneObservation } from "./room-pane-control.js";
export function liveWatchSubmission(observed: RoomPaneObservation, receipt: unknown, startedAt: string) {
  const data = receipt && typeof receipt === "object" ? receipt as Record<string, unknown> : {};
  return { startedAt, previousTaskIds: observed.tasks.map(task => task.taskId).slice(-256), turnId: typeof data.turnId === "string" && data.turnId ? data.turnId : null };
}
/** A native session/thread is reusable and is never itself a new turn identity. */
export function liveWatchedTask(watch: ControlWatch, observed: RoomPaneObservation) {
  if (watch.submission) {
    const { turnId, previousTaskIds, startedAt } = watch.submission;
    const candidates = observed.tasks.filter(task => turnId
      ? task.taskId === turnId || task.modelsUsed.some(model => model.turnId === turnId)
      : !previousTaskIds.includes(task.taskId) && task.timing.source === "NATIVE" && Boolean(task.timing.startedAt && Date.parse(task.timing.startedAt) >= Date.parse(startedAt) - 1000));
    // Without a native submission receipt, two new turns are ambiguous.
    return candidates.length === 1 ? candidates[0] : undefined;
  }
  return watch.targetTaskRef
    ? observed.tasks.find(task => task.taskId === watch.targetTaskRef)
    : undefined;
}
