import { useEffect, useRef, useState, type Dispatch, type PointerEvent as ReactPointerEvent, type SetStateAction } from "react";
import type { OpenProjectResult, Room } from "@space/contracts";
import { api } from "../../api.js";
import { ensureProjectFolder, reorderRoomsById, sortRoomsByOrder } from "./room-catalog.js";

// The Rooms dock: search and account filters, per-room project settings, the
// shared project picker and right-button drag reordering.

export type AdminRoomFilterMode = "mine" | "all" | "user";

export interface RoomsDockContext {
  rooms: Room[];
  setRooms: Dispatch<SetStateAction<Room[]>>;
  /** Shows a workspace error banner. */
  reportError: (message: string | null) => void;
  /** Saves a named project preset (a user preference). */
  addNamedProjectPreset: (label: string, path: string) => void;
}

export interface RoomsDock {
  roomSearch: string;
  setRoomSearch: (search: string) => void;
  adminRoomFilterMode: AdminRoomFilterMode;
  setAdminRoomFilterMode: (mode: AdminRoomFilterMode) => void;
  adminSelectedUserId: string;
  setAdminSelectedUserId: (userId: string) => void;
  /** The collapsed "Test rooms" group (Agent Proof and CLI Recovery rooms) was opened. */
  testRoomsOpen: boolean;
  setTestRoomsOpen: (open: boolean) => void;
  dockExpandedRoomId: string | null;
  setDockExpandedRoomId: Dispatch<SetStateAction<string | null>>;
  /** Project path drafts per room; also the fallback project of new CLI panes. */
  dockProjectPathDrafts: Record<string, string>;
  setDockProjectPathDrafts: Dispatch<SetStateAction<Record<string, string>>>;
  dockProjectSavingRoomId: string | null;
  setDockProjectSavingRoomId: (roomId: string | null) => void;
  isAddingPresetRoomId: string | null;
  setIsAddingPresetRoomId: (roomId: string | null) => void;
  newPresetDraft: string;
  setNewPresetDraft: (draft: string) => void;
  projectPickerRoom: { id: string; name: string } | null;
  setProjectPickerRoom: (room: { id: string; name: string } | null) => void;
  roomProjectSources: Record<string, string>;
  assignPickedProjectToRoom: (roomId: string, result: OpenProjectResult) => Promise<void>;
  handleAddNewPreset: (roomId: string) => Promise<void>;
  saveDockProject: (roomId: string) => Promise<void>;
  roomReorderPending: boolean;
  draggedRoomId: string | null;
  dragOverRoomId: string | null;
  handleRoomRightPointerDown: (event: ReactPointerEvent<HTMLElement>, roomId: string) => void;
}

export function useRoomsDock({ rooms, setRooms, reportError, addNamedProjectPreset }: RoomsDockContext): RoomsDock {
  const [roomSearch, setRoomSearch] = useState("");
  const [adminRoomFilterMode, setAdminRoomFilterMode] = useState<AdminRoomFilterMode>("mine");
  const [adminSelectedUserId, setAdminSelectedUserId] = useState<string>("");
  const [testRoomsOpen, setTestRoomsOpen] = useState(false);
  const [dockExpandedRoomId, setDockExpandedRoomId] = useState<string | null>(null);
  const [dockProjectPathDrafts, setDockProjectPathDrafts] = useState<Record<string, string>>({});
  const [dockProjectSavingRoomId, setDockProjectSavingRoomId] = useState<string | null>(null);
  const [isAddingPresetRoomId, setIsAddingPresetRoomId] = useState<string | null>(null);
  const [newPresetDraft, setNewPresetDraft] = useState("");
  // Shared project picker: a room assignment is bound to the room that opened the picker.
  const [projectPickerRoom, setProjectPickerRoom] = useState<{ id: string; name: string } | null>(null);
  const [roomProjectSources, setRoomProjectSources] = useState<Record<string, string>>({});
  const latestRoomsRef = useRef(rooms);
  latestRoomsRef.current = rooms;

  async function assignPickedProjectToRoom(roomId: string, result: OpenProjectResult) {
    const targetRoom = latestRoomsRef.current.find((r) => r.id === roomId);
    if (!targetRoom) throw new Error("The room was removed. The project is ready; choose it again from another room.");
    const updated = await api.updateRoom(roomId, { name: targetRoom.name, projectPath: result.projectPath });
    setRooms((current) => current.map((r) => (r.id === roomId ? updated : r)));
    setDockProjectPathDrafts((prev) => ({ ...prev, [roomId]: result.projectPath }));
    setRoomProjectSources((prev) => ({ ...prev, [roomId]: `${result.source.label}${result.source.detail ? ` · ${result.source.detail}` : ""}` }));
  }

  async function handleAddNewPreset(roomId: string) {
    const name = newPresetDraft.trim();
    if (!name || !/^[a-zA-Z0-9_-]+$/.test(name)) return;
    const projectPath = `/opt/spaceapp/projects/${name}`;
    await ensureProjectFolder(projectPath);
    addNamedProjectPreset(name, projectPath);
    setDockProjectPathDrafts((prev) => ({ ...prev, [roomId]: projectPath }));
    setIsAddingPresetRoomId(null);
    setNewPresetDraft("");
    const targetRoom = rooms.find((r) => r.id === roomId);
    if (targetRoom) {
      try {
        const updated = await api.updateRoom(roomId, {
          name: targetRoom.name,
          projectPath
        });
        setRooms((current) => current.map((r) => (r.id === roomId ? updated : r)));
      } catch (err) {
        reportError(err instanceof Error ? err.message : "Failed to save project");
      }
    }
  }

  async function saveDockProject(roomId: string) {
    if (dockProjectSavingRoomId) return;
    const targetRoom = rooms.find((r) => r.id === roomId);
    if (!targetRoom) return;
    setDockProjectSavingRoomId(roomId);
    const draft = dockProjectPathDrafts[roomId]?.trim() || null;
    try {
      if (draft) {
        await ensureProjectFolder(draft);
      }
      const updated = await api.updateRoom(roomId, {
        name: targetRoom.name,
        projectPath: draft
      });
      setRooms((current) => current.map((r) => (r.id === roomId ? updated : r)));
    } catch (err) {
      reportError(err instanceof Error ? err.message : "Failed to update project path");
    } finally {
      setDockProjectSavingRoomId(null);
    }
  }

  const [roomReorderPending, setRoomReorderPending] = useState(false);
  const [draggedRoomId, setDraggedRoomId] = useState<string | null>(null);
  const [dragOverRoomId, setDragOverRoomId] = useState<string | null>(null);
  const dragOverRoomIdRef = useRef<string | null>(null);
  const roomPointerDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => roomPointerDragCleanupRef.current?.(), []);

  function clearRoomReorderState() {
    roomPointerDragCleanupRef.current?.();
    roomPointerDragCleanupRef.current = null;
    dragOverRoomIdRef.current = null;
    setDraggedRoomId(null);
    setDragOverRoomId(null);
  }

  function handleRoomRightPointerDown(event: ReactPointerEvent<HTMLElement>, roomId: string) {
    if (event.button !== 2 || roomReorderPending) return;
    event.preventDefault();
    roomPointerDragCleanupRef.current?.();
    setDraggedRoomId(roomId);
    dragOverRoomIdRef.current = roomId;
    setDragOverRoomId(roomId);
    const pointerId = event.pointerId;
    const roomAtPoint = (clientX: number, clientY: number) =>
      document.elementFromPoint?.(clientX, clientY)?.closest<HTMLElement>(".room-item[data-room-id]")?.dataset.roomId ?? null;
    const roomFromEvent = (pointerEvent: PointerEvent) =>
      pointerEvent.target instanceof Element
        ? pointerEvent.target.closest<HTMLElement>(".room-item[data-room-id]")?.dataset.roomId ?? null
        : null;
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };
    const handlePointerMove = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId || (pointerEvent.buttons & 2) === 0) return;
      pointerEvent.preventDefault();
      const targetRoomId = roomFromEvent(pointerEvent) ?? roomAtPoint(pointerEvent.clientX, pointerEvent.clientY);
      if (!targetRoomId || targetRoomId === dragOverRoomIdRef.current) return;
      dragOverRoomIdRef.current = targetRoomId;
      setDragOverRoomId(targetRoomId);
    };
    const handlePointerUp = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId || pointerEvent.button !== 2) return;
      pointerEvent.preventDefault();
      const targetRoomId = roomFromEvent(pointerEvent) ?? roomAtPoint(pointerEvent.clientX, pointerEvent.clientY) ?? dragOverRoomIdRef.current ?? roomId;
      cleanup();
      roomPointerDragCleanupRef.current = null;
      void handleRoomDrop(targetRoomId, roomId);
    };
    const handlePointerCancel = (pointerEvent: PointerEvent) => {
      if (pointerEvent.pointerId !== pointerId) return;
      cleanup();
      roomPointerDragCleanupRef.current = null;
      clearRoomReorderState();
    };
    window.addEventListener("pointermove", handlePointerMove, { passive: false });
    window.addEventListener("pointerup", handlePointerUp, { passive: false });
    window.addEventListener("pointercancel", handlePointerCancel);
    roomPointerDragCleanupRef.current = cleanup;
  }

  async function handleRoomDrop(roomId: string, sourceRoomId = draggedRoomId) {
    if (!sourceRoomId || sourceRoomId === roomId || roomReorderPending) {
      clearRoomReorderState();
      return;
    }
    const previousRooms = rooms;
    const nextRooms = reorderRoomsById(previousRooms, sourceRoomId, roomId);
    clearRoomReorderState();
    setRooms(nextRooms);
    setRoomReorderPending(true);
    reportError(null);
    try {
      const reorderedRooms = await api.reorderRooms(nextRooms.map((room) => room.id));
      setRooms(sortRoomsByOrder(reorderedRooms));
    } catch (err) {
      setRooms(previousRooms);
      reportError(err instanceof Error ? err.message : "Room reorder failed");
    } finally {
      setRoomReorderPending(false);
    }
  }

  return {
    roomSearch,
    setRoomSearch,
    adminRoomFilterMode,
    setAdminRoomFilterMode,
    adminSelectedUserId,
    setAdminSelectedUserId,
    testRoomsOpen,
    setTestRoomsOpen,
    dockExpandedRoomId,
    setDockExpandedRoomId,
    dockProjectPathDrafts,
    setDockProjectPathDrafts,
    dockProjectSavingRoomId,
    setDockProjectSavingRoomId,
    isAddingPresetRoomId,
    setIsAddingPresetRoomId,
    newPresetDraft,
    setNewPresetDraft,
    projectPickerRoom,
    setProjectPickerRoom,
    roomProjectSources,
    assignPickedProjectToRoom,
    handleAddNewPreset,
    saveDockProject,
    roomReorderPending,
    draggedRoomId,
    dragOverRoomId,
    handleRoomRightPointerDown
  };
}

