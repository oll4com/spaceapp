import type { Pane, Room } from "@space/contracts";
import type { PaneCompletionLifecycleState } from "../../pane-completion-lifecycle.js";
import { workspaceRoomActivity } from "../ui-theme/workspace-room-filter.js";
import type { RoomsDock } from "./useRoomsDock.js";

// Kept out of RoomsDockPanel so App can filter rooms without loading the lazy dock (Slice 9).
export interface RoomEntry { room: Room; activity: ReturnType<typeof workspaceRoomActivity> }

/** Rooms shown in the dock: own rooms, or the admin's account filter, then the search. */
export function selectRoomEntries({ rooms, selectedRoomId, panes, roomRuntimes, completions, roomCliActivityCounts, isAdminMode, userId, dock, userEmailById, notificationRooms, listsEveryRoom = false }: {
  rooms: Room[];
  selectedRoomId: string | null;
  /** Panes of the active room. */
  panes: Pane[];
  roomRuntimes: Record<string, { panes: Pane[] }>;
  completions: PaneCompletionLifecycleState["panes"];
  roomCliActivityCounts: Record<string, number>;
  isAdminMode: boolean;
  userId: string | undefined;
  dock: Pick<RoomsDock, "roomSearch" | "adminRoomFilterMode" | "adminSelectedUserId">;
  userEmailById: Map<string, string>;
  /** Open notifications per room, from the notification store. */
  notificationRooms?: Record<string, number>;
  /** A USER's room list already holds only their own and shared rooms (multi-user, operator-approved 2026-10-17). */
  listsEveryRoom?: boolean;
}): { entries: RoomEntry[]; isRoomListFiltered: boolean } {
  const { roomSearch, adminRoomFilterMode, adminSelectedUserId } = dock;
  const entries = rooms.map(room => ({
    room,
    activity: workspaceRoomActivity(room.id === selectedRoomId ? panes : roomRuntimes[room.id]?.panes ?? [], completions, roomCliActivityCounts[room.id], notificationRooms?.[room.id] ?? 0)
  })).filter(({ room }) => {
    if (!isAdminMode) {
      if (!listsEveryRoom && room.ownerUserId && room.ownerUserId !== userId) return false;
    } else {
      if (adminRoomFilterMode === "mine") {
        if (room.ownerUserId && room.ownerUserId !== userId) return false;
      } else if (adminRoomFilterMode === "user") {
        if (adminSelectedUserId && room.ownerUserId !== adminSelectedUserId) return false;
      }
    }
    if (roomSearch.trim()) {
      const q = roomSearch.trim().toLowerCase();
      const nameMatch = room.name.toLowerCase().includes(q);
      const ownerEmail = room.ownerUserId ? userEmailById.get(room.ownerUserId) ?? "" : "";
      return nameMatch || ownerEmail.toLowerCase().includes(q);
    }
    return true;
  });
  const isRoomListFiltered = Boolean(roomSearch.trim()) || (isAdminMode && adminRoomFilterMode !== "mine");
  return { entries, isRoomListFiltered };
}
