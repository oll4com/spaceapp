import type { Pane, Room } from "@space/contracts";
import type { PaneCompletionLifecycleState } from "../../pane-completion-lifecycle.js";

export type WorkspaceRoomFilter = "all" | "running" | "attention";
/** `notificationCount`: open notifications of the room (the Notification Center); they count as attention like a blocked pane. */
export function workspaceRoomActivity(panes: readonly Pane[], completions: PaneCompletionLifecycleState["panes"], runningCliCount = 0, notificationCount = 0) {
  return {
    running: runningCliCount > 0 || panes.some(pane => !pane.isClosed && (pane.status === "RUNNING" || Boolean(completions[pane.id]?.activeRunKey))),
    attention: notificationCount > 0 || panes.some(pane => !pane.isClosed && (pane.status === "BLOCKED" || pane.status === "ERROR" || Boolean(completions[pane.id]?.pendingCompletionEventId)))
  };
}
export function workspaceRoomMatches(room: Room, query: string, filter: WorkspaceRoomFilter, activity: ReturnType<typeof workspaceRoomActivity>) {
  return room.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()) &&
    (filter === "all" || (filter === "running" ? activity.running : activity.attention));
}
