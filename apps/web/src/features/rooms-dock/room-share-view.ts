import type { Room } from "@space/contracts";

// Toolbar and rail controls that change a room: new panes, its name, its layout, sticky notes.
const roomWriteActions = new Set(["create", "rename-room", "pane-layout", "pane-span-all", "sticky-note"]);
const roomWriteRailIds = new Set(["create", "layout", "sticky"]);

/** MU-007: a room shared with the user to view only shows no control that would change it (the server refuses them). */
export const isViewOnlyRoom = (room: Room | null | undefined) => room?.sharePermission === "VIEW";

export function roomActionFilter(room: Room | null | undefined) {
  return (action: { id: string }) => !isViewOnlyRoom(room) || !(action.id.startsWith("add-") || roomWriteActions.has(action.id));
}

export function roomRailVisibility<T extends { isVisible: (id: string) => boolean }>(rail: T, room: Room | null | undefined): T {
  return isViewOnlyRoom(room) ? { ...rail, isVisible: (id: string) => !roomWriteRailIds.has(id) && rail.isVisible(id) } : rail;
}
